import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Address, contractAddress } from "@ton/core";
import { SignalHash_Referral as SignalHashReferral } from "./output/referral_SignalHash_Referral";
import { prepareTactDeployment } from "@tact-lang/deployer";

dotenv.config();

const NETWORK = (process.env.NETWORK || "testnet") as "testnet" | "mainnet";

(async (): Promise<void> => {

    let packageName = "referral_SignalHash_Referral.pkg";
    let owner = Address.parse(process.env.OWNER_ADDRESS ?? '');
    let merchant = Address.parse(process.env.MERCHANT_ADDRESS ?? '');
    let init = await SignalHashReferral.init(owner, merchant, 200000000n);

    // Load required data
    let address = contractAddress(0, init);
    let data = init.data.toBoc();
    let pkg = fs.readFileSync(path.resolve(__dirname, "output", packageName));

    // Prepareing
    console.log("Uploading package...");
    let prepare = await prepareTactDeployment({ pkg, data, testnet: NETWORK == "testnet" });

    // Deploying
    console.log("============================================================================================");
    console.log("Contract Address");
    console.log("============================================================================================");
    console.log();
    console.log(address.toString({ testOnly: NETWORK == "testnet"  }));
    console.log();
    console.log("============================================================================================");
    console.log("Please, follow deployment link");
    console.log("============================================================================================");
    console.log();
    console.log(prepare);
    console.log();
    console.log("============================================================================================");
})();
