const fs = require("fs");
const readline = require("readline");
const bluebird = require("bluebird");
const axios = require("axios");

const ethers = require("ethers");

const config = require("./../config.json");
const abi = require("./abi.json");
const abiitem = require("./abi-item.json");
const abihero = require("./abi-hero.json");
const rewardLookup = require("./rewards.json");

const callOptions = { gasPrice: config.gasPrice, gasLimit: config.gasLimit };
const xplimits = [
    0, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 16000, 20000, 24000,
    28000, 32000, 36000, 40000, 45000, 50000, 55000, 60000, 65000, 70000,
];

let provider, questContract, itemContract, wallet;

async function main() {
    try {
        provider = new ethers.providers.JsonRpcProvider(getRpc());

        questContract = new ethers.Contract(
            config.questContract,
            abi,
            provider
        );

        itemContract = new ethers.Contract(
            config.itemContract,
            abiitem,
            provider
        );

        heroContract = new ethers.Contract(
            config.heroContract,
            abihero,
            provider
        );

        wallet = fs.existsSync(config.wallet.encryptedWalletPath)
            ? await getEncryptedWallet()
            : await createWallet();

        console.clear();
        checkForQuests();
    } catch (err) {
        console.clear();
        console.error(`Unable to run: ${err.message}`);
    }
}

async function getEncryptedWallet() {
    let pw = config.wallet.password;

    try {
        let encryptedWallet = fs.readFileSync(
            config.wallet.encryptedWalletPath,
            "utf8"
        );
        let decryptedWallet = ethers.Wallet.fromEncryptedJsonSync(
            encryptedWallet,
            pw
        );
        return decryptedWallet.connect(provider);
    } catch (err) {
        throw new Error(
            'Unable to read your encrypted wallet. Try again, making sure you provide the correct password. If you have forgotten your password, delete the file "w-dfklevelup.json" and run the application again.'
        );
    }
}

async function createWallet() {
    console.log("\nHi. You have not yet encrypted your private key.");
    let pw = await promptForInput(
        "Choose a password for encrypting your private key, and enter it here: ",
        "password"
    );
    let pk = await promptForInput(
        "Now enter your private key: ",
        "private key"
    );

    try {
        let newWallet = new ethers.Wallet(pk, provider);
        let enc = await newWallet.encrypt(pw);
        fs.writeFileSync(config.wallet.encryptedWalletPath, enc);
        return newWallet;
    } catch (err) {
        throw new Error(
            "Unable to create your wallet. Try again, making sure you provide a valid private key."
        );
    }
}

async function promptForInput(prompt, promptFor) {
    const read = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        let input = await new Promise((resolve) => {
            read.question(prompt, (answer) => resolve(answer));
        });
        if (!input)
            throw new Error(
                `No ${promptFor} provided. Try running the application again, and provide a ${promptFor}.`
            );
        return input;
    } finally {
        read.close();
    }
}

async function checkForQuests() {
    while (true) {
        try {
            let herodata = await getHeroMetaData(
                config.quests[0].professionHeroes[0]
            );
            console.log("\nChecking for quests...");

            let activeQuests = await questContract.getAccountActiveQuests(
                config.wallet.address
            );

            // Display the finish time for any quests in progress
            let runningQuests = activeQuests.filter(
                (quest) => quest.completeAtTime >= Math.round(Date.now() / 1000)
            );
            runningQuests.forEach((quest) =>
                console.log(
                    `Quest led by ${herodata.name
                    } is due to complete at ${displayTime(
                        quest.completeAtTime
                    )}`
                )
            );

            // Complete any quests that need to be completed
            let doneQuests = activeQuests.filter(
                (quest) => !runningQuests.includes(quest)
            );
            for (const quest of doneQuests) {
                await completeQuest(quest.heroes[0]);
            }

            let herodata2 = await getHeroStats(
                config.quests[0].professionHeroes[0]
            );

            if (
                Number(herodata2.state.xp) >=
                xplimits[herodata2.state.level] - 250
            ) {
                console.log(
                    `\n***** ${herodata.name} is almost at full XP - Time to Level Up! *****\n`
                );
                await bluebird.delay(10000000000);
                return;
            }

            activeQuests = await questContract.getAccountActiveQuests(
                config.wallet.address
            );

            // Start any quests needing to start
            let questsToStart = await getQuestsToStart(activeQuests);

            //console.log("Quests to start", questsToStart);

            for (const quest of questsToStart) {
                await startQuest(quest);
            }
        } catch (err) {
            console.error(
                `An error occured. Will attempt to retry in ` +
                `${config.pollingInterval / 1000} seconds... Error:`,
                err
            );
        }

        let count = 0;
        console.log(
            `Waiting for quest to finish: ${(config.pollingInterval - count) / 1000
            } seconds remaining.`
        );
        while (count < config.pollingInterval) {
            count += 1000;
            await bluebird.delay(1000);
            console.log(
                `\x1B[1AWaiting for quest to finish: ${(config.pollingInterval - count) / 1000
                } seconds remaining.`
            );
        }
    }
}

async function getQuestsToStart(activeQuests) {
    var questsToStart = new Array();
    var questingHeroes = new Array();

    activeQuests.forEach((q) =>
        q.heroes.forEach((h) => questingHeroes.push(Number(h)))
    );

    for (const quest of config.quests) {
        if (quest.professionHeroes.length > 0) {
            var readyHeroes = await getHeroesWithGoodStamina(
                questingHeroes,
                quest,
                true
            );

            questsToStart.push({
                name: quest.name,
                address: quest.contractAddress,
                professional: true,
                heroes: readyHeroes,
                level: quest.level,
            });
        }
    }

    return questsToStart;
}

async function getHeroesWithGoodStamina(questingHeroes, quest, professional) {
    let minStamina = config.consumeStaminaVialIfMinStamina;

    let heroes = quest.professionHeroes;
    heroes = heroes.filter((h) => !questingHeroes.includes(h));

    const promises = heroes.map((hero) => {
        return questContract.getCurrentStamina(hero);
    });

    const results = await Promise.all(promises);

    const heroesWithGoodStaminaRaw = await bluebird.map(
        results,
        async (value, index) => {
            const stamina = Number(value);

            console.log("Current Stamina for this Hero is: ", stamina);

            if (stamina >= minStamina) {
                return heroes[index];
            } else {
                //Consume Stamina vial for heroes that have low Stamina (if Stamina vial is available)
                await consumeItem(
                    "0x242078edFDca25ef2A497C8D9f256Fd641472E5F",
                    heroes[index]
                );
                return heroes[index];
            }

            return null;
        }
    );

    const heroesWithGoodStamina = heroesWithGoodStaminaRaw.filter((h) => !!h);

    if (!heroesWithGoodStamina.length) {
        console.log(`${quest.name} quest is not ready to start.`);
    }

    return heroesWithGoodStamina;
}

async function startQuest(quest) {
    try {
        let batch = 0;
        while (true) {
            var groupStart = batch * config.maxQuestGroupSize;
            let questingGroup = quest.heroes.slice(
                groupStart,
                groupStart + config.maxQuestGroupSize
            );

            if (questingGroup.length === 0) break;

            await startQuestBatch(quest, questingGroup);
            batch++;
        }
    } catch (err) {
        console.warn(
            `Error determining questing group - this will be retried next polling interval`,
            err
        );
    }
}

async function startQuestBatch(quest, questingGroup) {
    const herodata = await getHeroMetaData(
        config.quests[0].professionHeroes[0]
    );

    try {
        console.log(`Starting ${quest.name} quest with ${herodata.name}.`);
        await tryTransaction(() =>
            questContract.connect(wallet).startQuest(
                questingGroup,
                quest.address,
                config.questAttempts, //Number of Quest Attempts
                quest.level, //Level
                callOptions
            )
        );
    } catch (err) {
        console.warn(
            `Error starting quest - this will be retried next polling interval.`
        );
    }
}

async function completeQuest(heroId) {
    let herodata = await getHeroMetaData(config.quests[0].professionHeroes[0]);

    try {
        console.log(`Completing quest led by ${herodata.name}.`);

        let receipt = await tryTransaction(() =>
            questContract.connect(wallet).completeQuest(heroId, callOptions)
        );

        console.log(`\n***** Completed quest led by ${herodata.name} *****\n`);

        let xpEvents = receipt.events.filter((e) => e.event === "QuestXP");

        const xpIncrease = xpEvents.reduce(
            (total, result) => total + Number(result.args.xpEarned),
            0
        );

        console.log(
            `XP: +${xpEvents.reduce(
                (total, result) => total + Number(result.args.xpEarned),
                0
            )}`
        );

        herodata = await getHeroStats(config.quests[0].professionHeroes[0]);
        console.log(
            `Current XP: ${herodata.state.xp} / ${xplimits[herodata.state.level]
            }`
        );

        /*let suEvents = receipt.events.filter((e) => e.event === "QuestSkillUp");

        const skillIncrease = suEvents.reduce((total, result) => total + Number(result.args.skillUp),0) / 10;

        if(skillIncrease > 0){
            console.log(`\n \x1b[33m *** Nice, it's a SkillUp! *** \x1b[0m`);
            console.log(
                `Foraging Skill +${
                    suEvents.reduce(
                        (total, result) => total + Number(result.args.skillUp),
                        0
                    ) / 10}`
            );
        }*/

        /*let rwEvents = receipt.events.filter((e) => e.event === "QuestReward");
        rwEvents.forEach((result) =>
            console.log(
                `${result.args.itemQuantity} x ${getRewardDescription(
                    result.args.rewardItem
                )}`
            )
        );*/

        console.log("\n*****\n");
    } catch (err) {
        console.warn(
            `Error completing quest for ${herodata.name} - this will be retried next polling interval.`
        );
    }
}

async function tryTransaction(transaction) {
    const timeout = setTimeout(() => {
        console.log("Timeout - should restart now.");
        process.exit();
    }, 60000);

    try {
        var tx = await transaction();
        let receipt = await tx.wait();
        if (receipt.status !== 1) {
            console.log("Receipt threw an error.");
            throw new Error(`Receipt had a status of ${receipt.status}`);
        }
        clearTimeout(timeout);
        return receipt;
    } catch (err) {
        //if (i === attempts - 1)
        console.log("Error broadcasting transaction - should restart now.");
        process.exit();
        throw err;
    }
}

function getRewardDescription(rewardAddress) {
    let desc = rewardLookup[rewardAddress];
    return desc ? desc : rewardAddress;
}

function getRpc() {
    return config.useBackupRpc ? config.rpc.poktRpc : config.rpc.DFKRpc;
}

function displayTime(timestamp) {
    var a = new Date(timestamp * 1000);
    var hour = a.getHours();
    var min = a.getMinutes();
    var sec = a.getSeconds();
    return hour + ":" + min + ":" + sec;
}

async function consumeItem(itemAddress, heroID) {
    const herodata = await getHeroMetaData(
        config.quests[0].professionHeroes[0]
    );

    try {
        console.log(`Consuming Stamina Vial with ${herodata.name}.`);

        await tryTransaction(() =>
            itemContract.connect(wallet).consumeItem(itemAddress, heroID)
        );
    } catch (err) {
        console.warn(
            `Error consuming item for ${herodata.name} - this will be retried next polling interval.`
        );
    }
}

async function getHeroMetaData(heroID) {

    const config = {
        method: "get",
        url: `https://heroes.defikingdoms.com/token/${heroID}`,
    };

    let result = await axios(config);

    return result.data;
}

async function getHeroStats(heroID) {

    let hero = await heroContract.getHero(heroID);

    //console.log("Hero XP: ", Number(hero.state.xp))
    //console.log("Hero Level: ", Number(hero.state.level))
    //console.log("Hero Stamina: ", hero.stats.stamina)

    return hero;
}

main();
