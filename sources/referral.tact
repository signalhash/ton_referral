import "@stdlib/ownable";

message(0x5032a9ac) SetReserve {
    minReserve: Int; 
}

message(0xccce9a8a) SignalHashPromote {
    memo: String; 
    ref: Address; 
    bpsB: Int; 
}

// ---------- Contract ----------
contract SignalHash_Referral with Ownable {
    // Ownable
    owner: Address;
    // Defaults
    defToA: Address; 
    minReserve: Int;

    // Policy constants
    const CAP_BPS_B_MAX: Int = 1000; // 10% in bps
    const MIN_PAYMENT: Int = 200000000; // 0.2 TON in nanotons

    init(owner: Address, toA: Address, reserve: Int) {
        self.owner = owner;
        self.defToA = toA;
        self.minReserve = reserve;
    }

    // --- Admin: set target reserve ---
    receive(msg: SetReserve) {
        require(sender() == self.owner, "not_owner");

        self.minReserve = msg.minReserve;
    }

    receive(msg: SignalHashPromote) {
        let amount: Int = context().value;

        if (amount < self.MIN_PAYMENT) {
            return;
        }

        let balBefore: Int = myBalance();
        let need: Int = (self.minReserve > balBefore) ? (self.minReserve - balBefore) : 0;
        if (amount <= need) {
            return;
        }

        let distributable: Int = amount - need;
        if (distributable <= 0) {
            return;
        }

        // 1) protect storage first
        nativeReserve(self.minReserve, ReserveExact);

        // 2) normalize and cap requested bpsB
        let req: Int = msg.bpsB;
        if (req < 0) {
            req = 0;
        }
        if (req > 10000) {
            req = 10000;
        }
        let eBpsB: Int = (req <= self.CAP_BPS_B_MAX) ? req : self.CAP_BPS_B_MAX;

        // 3) compute shares
        let partB: Int = (distributable * eBpsB) / 10000;

        // 4) build memos as standard text comments (op=0)
        if (partB > 0) {
            let bodyB: Cell = beginCell()
                .storeUint(0, 32)
                .storeSlice(msg.memo.asSlice())
                .storeSlice(", Referral ".asSlice())
                .storeSlice((eBpsB / 100).toString().asSlice()) // show capped integer %
                .storeSlice("% from #SignalHash".asSlice())
                .endCell();

            // 5) pay B exact, sweep remainder to A
            message(MessageParameters {
                to: msg.ref,
                value: partB,
                mode: SendPayFwdFeesSeparately | SendIgnoreErrors,
                body: bodyB,
            });
        }

        let bodyA: Cell = beginCell()
            .storeUint(0, 32)
            .storeSlice(msg.memo.asSlice())
            .storeSlice(", Promote to #SignalHash".asSlice())
            .endCell();

        message(MessageParameters {
            to: self.defToA,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            body: bodyA,
        });
    }

    get fun merchant(): Address {
        return self.defToA;
    }

    get fun get_contract_metadata(): Cell {
        return beginCell()
                .storeSlice("https://contracts.signalhash.io/public/signalhash-ref.json".asSlice())
                .endCell();
    }
}
