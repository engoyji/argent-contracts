// How to run this test file:
// 1. add your private key (KOVAN_PRIV_KEY) and Infura API key (INFURA_KEY) to .env
// --- TO TEST ON KOVAN: ----
// 2. npx etherlime test test/makerV2Manager_invest.js --skip-compilation --network kovan
// --- TO TEST ON KOVAN-FORK: ----
// 2. npm run kovan-fork
// 3. npx etherlime test test/makerV2Manager_invest.js --skip-compilation --network kovan-fork

/* global artifacts */
const { parseEther } = require("ethers").utils;
const TestManager = require("../../utils/test-manager");
const DeployManager = require("../../utils/deploy-manager.js");
const UniswapFactory = require("../../lib/uniswap/UniswapFactory");
const UniswapExchange = require("../../lib/uniswap/UniswapExchange");

const ScdMcdMigration = artifacts.require("ScdMcdMigration");
const Join = artifacts.require("JoinLike");
const MakerV2Manager = artifacts.require("MakerV2Manager");
const MakerRegistry = artifacts.require("MakerRegistry");
const Wallet = artifacts.require("BaseWallet");
const DSToken = artifacts.require("DSToken");

const DEFAULT_NETWORK = "kovan"; // a bug in kovan-fork makes some tests fail => use kovan
const SENT_AMOUNT = parseEther("0.00000001");

describe("Test MakerV2 DSR", () => {
  if (!process.argv.join(" ").includes(__filename.slice(__dirname.length + 1))) {
    // We do not want to run this file as part of the complete test suite.
    // This is because this test file can only be run on kovan or kovan-fork
    // (using the --fork option of ganache-cli) whereas other test files are run using ganache
    return;
  }

  let wallet;
  let testManager;
  let makerV2;
  let saiToken;
  let daiToken;
  let walletAddress;
  let owner;
  let deployer;

  before(async () => {
    const idx = process.argv.indexOf("--network");
    const network = idx > -1 ? process.argv[idx + 1] : DEFAULT_NETWORK;
    if (!network.includes("kovan")) throw new Error("--network must be 'kovan' or 'kovan-fork'");

    const deployManager = new DeployManager(network);
    await deployManager.setup();
    const { configurator } = deployManager;
    deployer = deployManager.deployer;
    testManager = new TestManager([...Array(10)].map(() => deployer), network, deployer);
    owner = deployer.signer;
    const { config } = configurator;

    const migration = await ScdMcdMigration.at(config.defi.maker.migration);
    const vat = await migration.vat();
    const makerRegistry = await deployer.deploy(MakerRegistry, {}, vat);
    makerV2 = await deployer.deploy(
      MakerV2Manager,
      {},
      config.contracts.ModuleRegistry,
      config.modules.GuardianStorage,
      config.defi.maker.migration,
      config.defi.maker.pot,
      config.defi.maker.jug,
      makerRegistry.address,
      config.defi.uniswap.factory,
      { gasLimit: 8000000 },
    );

    const daiJoinAddress = await migration.daiJoin();
    const daiJoin = await Join.at(daiJoinAddress);

    const saiJoin = await migration.saiJoin();
    const saiJoin = await Join.at(saiJoin);

    const daiTokenAddress = await daiJoin.dai()
    daiToken = await DSToken.at(daiTokenAddress);
    const saiTokenAddress = await saiJoin.gem();
    saiToken = await DSToken.at(saiTokenAddress);

    const daiBalance = await daiToken.balanceOf(owner.address);
    if (daiBalance.lt(parseEther("1"))) {
      const uniswapFactory = await UniswapFactory.at(config.defi.uniswap.factory);
      const uniswapExchangeAddress = await uniswapFactory.getExchange(daiToken.address);
      const daiExchange = await UniswapExchange.at(uniswapExchangeAddress);
      await (await daiExchange.send(parseEther("0.02"), { gasLimit: 3000000 })).wait();
    }

    const saiBalance = await saiToken.balanceOf(owner.address);
    if (saiBalance.lt(parseEther("1"))) {
      const convertedToSai = (await daiToken.balanceOf(owner.address)).div(2);
      await (await daiToken.approve(migration.address, convertedToSai)).wait();
      await (await migration.swapDaiToSai(convertedToSai)).wait();
    }

    wallet = await deployer.deploy(Wallet);
    await (await wallet.init(owner.address, [makerV2.address])).wait();
    walletAddress = wallet.address;
  });

  async function topUpDai() {
    const walletDai = await daiToken.balanceOf(walletAddress);
    if (walletDai.lt(SENT_AMOUNT)) {
      await (await daiToken.transfer(walletAddress, SENT_AMOUNT)).wait();
    }
  }

  async function topUpPot() {
    const invested = await makerV2.dsrBalance(walletAddress);
    if (invested.lt(SENT_AMOUNT)) {
      await topUpDai();
      await (await daiToken.transfer(walletAddress, SENT_AMOUNT)).wait();
      await (await makerV2.joinDsr(walletAddress, SENT_AMOUNT, { gasLimit: 2000000 })).wait();
    }
  }

  describe("DSR", () => {
    async function exchangeWithPot({ toPot, relayed, all = false }) {
      const walletBefore = (await daiToken.balanceOf(walletAddress)).add(await saiToken.balanceOf(walletAddress));
      const investedBefore = await makerV2.dsrBalance(walletAddress);
      let method;
      if (toPot) {
        method = "joinDsr";
      } else if (all) {
        method = "exitAllDsr";
      } else {
        method = "exitDsr";
      }
      const params = [walletAddress].concat(all ? [] : [SENT_AMOUNT]);
      if (relayed) {
        await testManager.relay(makerV2, method, params, { contractAddress: walletAddress }, [owner]);
      } else {
        await (await makerV2[method](...params, { gasLimit: 2000000 })).wait();
      }
      const walletAfter = (await daiToken.balanceOf(walletAddress)).add(await saiToken.balanceOf(walletAddress));
      const investedAfter = await makerV2.dsrBalance(walletAddress);
      const deltaInvested = toPot ? investedAfter.sub(investedBefore) : investedBefore.sub(investedAfter);
      const deltaWallet = toPot ? walletBefore.sub(walletAfter) : walletAfter.sub(walletBefore);
      assert.isTrue(deltaInvested.gt(0), "DAI in DSR should have changed.");
      assert.isTrue(deltaWallet.gt(0), "DAI in wallet should have changed.");

      if (all) {
        assert.isTrue(investedAfter.eq(0), "Pot should be emptied");
        assert.isTrue(walletAfter.gt(walletBefore), "DAI in wallet should have increased");
      }
    }

    it("sends DAI to the pot (blockchain tx)", async () => {
      await topUpDai();
      await exchangeWithPot({ toPot: true, relayed: false });
    });

    it("sends DAI to the pot (relayed tx)", async () => {
      await topUpDai();
      await exchangeWithPot({ toPot: true, relayed: true });
    });

    it("withdraw DAI from the pot (blockchain tx)", async () => {
      await topUpPot();
      await exchangeWithPot({ toPot: false, relayed: false });
    });

    it("withdraw DAI from the pot (relayed tx)", async () => {
      await topUpPot();
      await exchangeWithPot({ toPot: false, relayed: true });
    });

    it("withdraw ALL DAI from the pot (blockchain tx)", async () => {
      await topUpPot();
      await exchangeWithPot({ toPot: false, relayed: false, all: true });
    });

    it("withdraw ALL DAI from the pot (relayed tx)", async () => {
      await topUpPot();
      await exchangeWithPot({ toPot: false, relayed: true, all: true });
    });
  });
});
