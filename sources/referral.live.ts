import "dotenv/config";
import { Address, beginCell, toNano, internal, fromNano, Cell, SendMode } from "@ton/core";
import { TonClient, WalletContractV4, WalletContractV5R1, OpenedContract } from "@ton/ton";
import { mnemonicToWalletKey } from "@ton/crypto";
import { getHttpEndpoint } from "@orbs-network/ton-access";

type WalletAny = WalletContractV4 | WalletContractV5R1;

const MNEMONIC = process.env.MNEMONIC!;
const EXPECTED_WALLET = process.env.EXPECTED_WALLET!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
const NETWORK = (process.env.NETWORK || "testnet") as "testnet" | "mainnet";
const TONKEY = process.env.TON_APIKEY!;

if (!MNEMONIC || !EXPECTED_WALLET || !CONTRACT_ADDRESS) {
    console.error("Missing env: MNEMONIC / EXPECTED_WALLET / CONTRACT_ADDRESS");
    process.exit(1);
}

function parseTon(friendly: string) {
    // Accepts any bounceable/test-only flags; compares on raw form
    return Address.parse(friendly);
}
function raw(a: Address) {
    return a.toString(); // "0:<hex>"
}

/** Try common wallet types until the derived address matches EXPECTED_WALLET */
async function openV5(client: TonClient): Promise<{
    wallet: OpenedContract<WalletContractV5R1>;
    secretKey: Buffer;
}> {
    const exp = Address.parse(EXPECTED_WALLET);
    let getMethodResult = await client.runMethod(exp, "seqno"); // run "seqno" GET method from your wallet contract
    let seqno = getMethodResult.stack.readNumber();

    const key = await mnemonicToWalletKey(MNEMONIC.split(" "));

    const w = client.open(
        WalletContractV5R1.create({
            walletId: { networkGlobalId: NETWORK == "testnet" ?  -3: -257 },
            publicKey: key.publicKey,
        })
    );

    if (EXPECTED_WALLET) {
        if (raw(w.address) !== raw(exp)) {
            throw new Error(
                `Mnemonic != EXPECTED_WALLET\nExpected: ${exp.toString({
                    testOnly: true, bounceable: false
                })}\nDerived : ${w.address.toString({ testOnly: true, bounceable: false })}`
            );
        }
    }

    return { wallet: w, secretKey: key.secretKey };
}

// -------------------- Payload builders --------------------

/** message(0x5032a9ac) SetReserve { minReserve: Int; }  // nanotons */
function buildSetReserve(minReserveNano: bigint) {
    return beginCell()
        .storeUint(0x5032a9ac, 32)
        .storeInt(minReserveNano, 257) // Int in Tact is usually 257-bit wide
        .endCell();
}

/** message(0xccce9a8a) SignalHashPromote { memo: String; ref: Address; bpsB: Int; } */
function buildSignalHashPromote(memo: string, refAddr: string, bpsB: number) {
    const ref = Address.parse(refAddr);
    return beginCell()
        .storeUint(0xccce9a8a, 32)
        .storeStringRefTail(memo)
        .storeAddress(ref)
        .storeInt(BigInt(bpsB), 257)
        .endCell();
}

// -------------------- Sender --------------------

async function sendInternal(to: Address, valueNano: bigint, body: Cell) {

    const endpoint = await getHttpEndpoint({ network: NETWORK });

    const client = new TonClient({ endpoint, apiKey: TONKEY });

    const { wallet, secretKey } = await openV5(client);

    const seqno = await wallet.getSeqno();

    console.log(`Network       : ${NETWORK}`);
    console.log(`From          : ${wallet.address.toString()}`);
    console.log(`To (contract) : ${to.toString()}`);
    console.log(`Amount        : ${fromNano(valueNano)} TON`);
    console.log(`Seqno         : ${seqno}`);
    console.log(`Payload (b64) : ${body.toBoc().toString("base64")}`);

    await wallet.sendTransfer({
        seqno,
        secretKey,
        authType: "external", // V5R1 requires this
        sendMode: SendMode.PAY_GAS_SEPARATELY, // safe default
        messages: [internal({ to, value: valueNano, bounce: true, body })],
    });

    // wait for seqno bump
    for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const now = await wallet.getSeqno();
        if (now > seqno) {
            console.log("✔️  Sent. Check tonviewer.");
            return;
        }
    }
    console.warn("Tx may still be pending (seqno did not advance yet).");
}

// -------------------- CLI --------------------

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const contract = Address.parse(CONTRACT_ADDRESS);

    if (cmd === "set-reserve") {
        // Usage: ts-node cli.ts set-reserve --min 0.10 --pay 0.20
        const minIdx = rest.indexOf("--min");
        const payIdx = rest.indexOf("--pay");
        const minTON = minIdx >= 0 ? rest[minIdx + 1] : undefined;
        const payTON = payIdx >= 0 ? rest[payIdx + 1] : "0.20";
        if (!minTON) throw new Error("Missing --min <TON>");

        const body = buildSetReserve(toNano(minTON));
        await sendInternal(contract, toNano(payTON), body);
        return;
    }

    if (cmd === "promote") {
        // Usage:
        // ts-node cli.ts promote --memo "Invoice:..." --ref EQ... --bps 700 --pay 1
        const memo = getArg(rest, "--memo");
        const ref = getArg(rest, "--ref");
        const bps = parseInt(getArg(rest, "--bps") || "0", 10);
        const payTON = getArg(rest, "--pay") || "1";
        if (!memo || !ref || !(bps >= 0)) {
            throw new Error('Usage: promote --memo "..." --ref <addr> --bps <0..10000> [--pay <TON>]');
        }

        const body = buildSignalHashPromote(memo, ref, bps);
        await sendInternal(contract, toNano(payTON), body);
        return;
    }

    console.log(
        [
            "Usage:",
            "  ts-node cli.ts set-reserve --min <TON> [--pay <TON>]",
            '  ts-node cli.ts promote    --memo "Invoice:..." --ref <addr> --bps <0..10000> [--pay <TON>]',
        ].join("\n")
    );
}

function getArg(args: string[], flag: string) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

//npx ts-node sources/referral.live.test.ts promote --memo "Invoice:03603999296428015565-7" --ref 0QB3wfd9x1Zb7Kxjb8f7o-wdDg6eetg1egrD66vDhBEDAj91 --bps 700 --pay 0.3
