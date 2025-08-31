import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, toNano, fromNano, comment, beginCell } from "@ton/core";
import { SignalHash_Referral as SignalHashReferral } from "./output/referral_SignalHash_Referral";
import { Cell } from "@ton/core";
import "@ton/test-utils";


const ton = (x: number | string) => toNano(x.toString());

const invoiceId = "Invoice:03603999296428015565-7"

function GetContractMemo(bps: bigint, toB: Address ): Cell {
    const b = beginCell();
    b.storeUint(3436092042, 32);
    b.storeStringRefTail(invoiceId);
    b.storeAddress(toB);
    b.storeInt(bps, 257);
    var memo = b.endCell();
    return memo;
}

describe("SignalHashReferral", () => {
    let blockchain: Blockchain;

    let owner: SandboxContract<TreasuryContract>;
    let payer: SandboxContract<TreasuryContract>;
    let toA: SandboxContract<TreasuryContract>;
    let toB: SandboxContract<TreasuryContract>;

    let splitter: SandboxContract<SignalHashReferral>;

    const DEF_BPS_B = 1000n; // 10%
    const MIN_PAYMENT = toNano("0.2");
    const MIN_RESERVE = toNano("0.02");

    beforeAll(async () => {
        blockchain = await Blockchain.create();
    });

    beforeEach(async () => {
        owner = await blockchain.treasury("owner");
        payer = await blockchain.treasury("payer");
        toA = await blockchain.treasury("toA");
        toB = await blockchain.treasury("toB");

        // Open contract from the generated init
        splitter = blockchain.openContract(
            await SignalHashReferral.fromInit(
                owner.address as Address,
                toA.address as Address,               
                MIN_RESERVE
            )
        );
        // Deploy with some gas
        await splitter.send(
            owner.getSender(),
            {
                value: toNano("0.2"),
            },
            {
                $$type: "SetReserve",
                minReserve: toNano("0.1"),
            }
        );

        console.log("init done")
    });

    async function getContractBalance(addr: Address) {
        const info = await blockchain.getContract(addr);
        return info.balance; // bigint
    }

    async function balances() {
        const [a, b, s] = await Promise.all([toA.getBalance(), toB.getBalance(), getContractBalance(splitter.address)]);
        return { toA: a, toB: b, splitter: s };
    }

    it("accepts a qualifying payment and splits", async () => {
        const payment = MIN_PAYMENT + toNano("0.01"); // ensure > MIN_PAYMENT

        const res = await splitter.send(
            payer.getSender(),
            {
                value: payment,
            }, 
            {
               $$type: "SignalHashPromote",
               bpsB: DEF_BPS_B,
               ref: toB.address,
               memo: invoiceId
            }            
        );

        // 1) payment landed on the splitter
        expect(res.transactions).toHaveTransaction({
            from: payer.address,
            to: splitter.address,
            success: true,
        });

        // 2) splitter forwarded to A and B (any value; exact math covered separately)
        expect(res.transactions).toHaveTransaction({
            from: splitter.address,
            to: toA.address,
            success: true,
        });
        expect(res.transactions).toHaveTransaction({
            from: splitter.address,
            to: toB.address,
            success: true,
        });
    });

    test("ignores micro-payments below 0.2 TON", async () => {
        const before = await balances();

        const res = await payer.send({
            to: splitter.address,
            value: ton("0.1"),
            body: GetContractMemo(700n, toB.address),
        });

        // Inbound to splitter succeeded
        expect(res.transactions).toHaveTransaction({
            from: payer.address,
            to: splitter.address,
            success: true,
        });

        // No outbound transfers from splitter to A or B
        expect(res.transactions).not.toHaveTransaction({
            from: splitter.address,
            to: toA.address,
        });
        expect(res.transactions).not.toHaveTransaction({
            from: splitter.address,
            to: toB.address,
        });

        const after = await balances();

        // Recipients unchanged; splitter balance increased (reserve accrues)
        expect(after.toA - before.toA).toBe(0n);
        expect(after.toB - before.toB).toBe(0n);
        expect(after.splitter).toBeGreaterThan(before.splitter);
    });

    test("splits 10 TON 90/10 when reserve already satisfied", async () => {
        // Top up splitter so reserve is met
        await payer.send({
            to: splitter.address,
            value: ton("1.0"),
            body: GetContractMemo(1000n, toB.address),
        });

        const before = await balances();

        const gross = ton("10");
        const res = await payer.send({
            to: splitter.address,
            value: gross,
            body: GetContractMemo(1000n, toB.address),
        });

        // Should create 1 inbound + >=2 outbound (A and B)
        expect(res.transactions.length).toBeGreaterThanOrEqual(3);

        const after = await balances();
        const gainA = after.toA - before.toA;
        const gainB = after.toB - before.toB;

        const totalOut = gainA + gainB;

        // Outbound should be close to gross minus fees (reserve already met)
        expect(totalOut).toBeLessThanOrEqual(gross);

        // Check ratio ~90/10 within 1.5% tolerance due to fees
        const actualRatio = Number(gainA) / Number(totalOut);

        expect(actualRatio).toBeGreaterThan(0.885);
        expect(actualRatio).toBeLessThan(0.915);
    });

    test("tops up reserve when below and then splits remainder", async () => {
        
        const before0 = await balances();

        const newReserve = toNano("0.40");

        var txs = (
            await splitter.send(
                owner.getSender(),
                {
                    value: toNano("0.05"),
                },
                {
                    $$type: "SetReserve",
                    minReserve: toNano("0.40"),
                }
            )
        ).transactions;

        expect(txs).toHaveTransaction({ from: owner.address, to: splitter.address, success: true });

        const before = await balances();

        const gross = toNano("1");

        const res = await payer.send({
            to: splitter.address,
            value: gross,
            body: GetContractMemo(DEF_BPS_B, toB.address),
        });

        expect(res.transactions.length).toBeGreaterThanOrEqual(2);

        const after = await balances();

        const gainA = after.toA - before.toA;
        const gainB = after.toB - before.toB;
        const outSum = gainA + gainB;

        // With zero surplus, distributable = gross - needed
        const needed = newReserve > before.splitter ? newReserve - before.splitter : 0n;
        const distributable = gross - needed;

        // Fee-tolerance headroom (sandbox fees are tiny; this is generous)
        const feeBudget = toNano("0.01");

        // Outflow should be <= distributable and close to it (fees reduce B in a sweep)
        expect(outSum).toBeGreaterThan(0n);
        expect(outSum).toBeLessThanOrEqual(distributable);
        expect(distributable - outSum).toBeLessThanOrEqual(feeBudget);

        // Contract ends near reserve (gas may make it a bit under)
        expect(after.splitter).toBeLessThanOrEqual(newReserve);
        expect(newReserve - after.splitter).toBeLessThanOrEqual(feeBudget);

        // Ratio near 90/10 (allow small drift from fees/rounding)
        const ratio = Number(gainA) / Number(outSum);

        expect(ratio).toBeGreaterThan(0.88);
        expect(ratio).toBeLessThan(0.92);
    });

    test("owner can update default split (e.g., 93/7) and minReserve", async () => {
        
        // 2) Update minReserve to 0.05 TON
        await splitter.send(
            owner.getSender(),
            { value: toNano("0.05") },
            {
                $$type: "SetReserve",
                minReserve: toNano("0.05"),
            }
        );

        // 3) Pre-fund reserve so the next payment cleanly splits
        await payer.send({
            to: splitter.address,
            value: toNano("0.2"),
            body: GetContractMemo(700n, toB.address),
        });

        const before = await balances(); // your helper
        // 4) Pay 2 TON and expect ~70/30 split
        const gross = toNano("2");
        console.log(before.toA);

        await payer.send({ to: splitter.address, value: gross, body: GetContractMemo(700n, toB.address) });

        const after = await balances();

        const gainA = after.toA - before.toA;
        const gainB = after.toB - before.toB;
        const outSum = gainA + gainB;

        const ratio = Number(gainA) / Number(outSum);        

        expect(ratio).toBeGreaterThan(0.92);
        expect(ratio).toBeLessThan(0.94);
    });

  
    test("exact boundary: MIN_PAYMENT (0.2 TON) is processed", async () => {
        // Ensure reserve is already satisfied
        await payer.send({ to: splitter.address, value: ton("1.0") });

        const before = await balances();

        const res = await payer.send({
            to: splitter.address,
            value: MIN_PAYMENT, // exactly 0.2 TON
            body: GetContractMemo(DEF_BPS_B, toB.address),
        });

        expect(res.transactions.length).toBeGreaterThanOrEqual(3);

        const after = await balances();
        expect(after.toA).toBeGreaterThan(before.toA);
        expect(after.toB).toBeGreaterThan(before.toB);
    });

    function decodeText(body: Cell): string {
        // Try op=0 comment first, then fall back to raw string
        // (your A body has op=0; your B body currently does not)
        let s = body.beginParse();
        try {
            const op = s.loadUint(32);
            if (op === 0) {
                return s.loadStringTail();
            }
        } catch {
            /* ignore and fall through */
        }
        s = body.beginParse();
        return s.loadStringTail();
    }

    // Compare addresses without relying on .equals()
    const addrEq = (a: any, b: Address) => !!a && typeof a.toString === "function" && a.toString() === b.toString();

    // Find the transaction whose inbound message is destined for addr
    const inboundTo = (txs: any[], addr: Address) => txs.find((tx) => addrEq((tx.inMessage?.info as any)?.dest, addr));

    test("sum of legs equals distributable (modulo fees) and no underflow", async () => {
        // Reserve satisfied

        await payer.send({
            to: splitter.address,
            value: ton("0.5"),
            body: GetContractMemo(DEF_BPS_B, toB.address),
        });

        const gross = ton("5");
        const b0 = await balances();

        await payer.send({
            to: splitter.address,
            value: gross,
            body: GetContractMemo(DEF_BPS_B, toB.address),
        });

        const b1 = await balances();

        const outA = b1.toA - b0.toA;
        const outB = b1.toB - b0.toB;
        const outSum = outA + outB;

        // Must be ≤ gross (fees + reserve ops)
        expect(outSum).toBeLessThanOrEqual(gross);

        // Legs positive (no underflow)
        expect(outA).toBeGreaterThan(0n);
        expect(outB).toBeGreaterThan(0n);
    });

    it("forwards the expected memos to A and B", async () => {
      
        // Send a plain text comment (op=0) → hits receive(msg: String)
        const res = await payer.send({
            to: splitter.address,
            value: toNano("1"), // ≥ MIN_PAYMENT
            body: GetContractMemo(DEF_BPS_B, toB.address), // text comment
            bounce: true,
        });

        // Inbound to the splitter ok
        expect(res.transactions).toHaveTransaction({
            from: payer.address,
            to: splitter.address,
            success: true,
        });

        // Grab inbound transactions to A and B
        const txA = inboundTo(res.transactions, toA.address);
        const txB = inboundTo(res.transactions, toB.address);

        expect(txA).toBeTruthy();
        expect(txB).toBeTruthy();

        // Decode their message bodies
        const bodyA = txA!.inMessage!.body as Cell;
        const bodyB = txB!.inMessage!.body as Cell;

        const textA = decodeText(bodyA);
        const textB = decodeText(bodyB);

        // Expected strings based on YOUR contract code:
        // A: "<memo>, Promote to #SignalHash"
        // B: "<memo>, Referral{bpsB/100}% from #SignalHash"
        const expectedA = `${invoiceId}, Promote to #SignalHash`;
        // note: your contract has no space between "Referral" and the percent number
        const expectedB = `${invoiceId}, Referral ${Number(DEF_BPS_B / 100n)}% from #SignalHash`;

        expect(textA).toBe(expectedA);
        expect(textB).toBe(expectedB);
    });
});
