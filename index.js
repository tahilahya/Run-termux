console.log('Memulai bot...');
const { Telegraf } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const config = require('./config');

const premiumPath = './premium.json';

const getPremiumUsers = () => { try { return JSON.parse(fs.readFileSync(premiumPath)); } catch (e) { fs.writeFileSync(premiumPath, '[]'); return []; } };
const savePremiumUsers = (users) => { fs.writeFileSync(premiumPath, JSON.stringify(users, null, 2)); };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let waClient = null;
let waConnectionStatus = 'closed';

async function startWhatsAppClient() {
    console.log("Mencoba memulai koneksi WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);
    
    waClient = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Mac OS", "Safari", "10.15.7"]
    });

    waClient.ev.on('creds.update', saveCreds);

    waClient.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        waConnectionStatus = connection;
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi WhatsApp tertutup. Alasan:', new Boom(lastDisconnect?.error).message, '|| Coba sambung ulang:', shouldReconnect);
            if (shouldReconnect) { setTimeout(startWhatsAppClient, 5000); } 
            else { console.log("Tidak bisa menyambung ulang."); waClient = null; }
        } else if (connection === 'open') {
            console.log('Berhasil tersambung ke WhatsApp!');
        }
    });
}

async function handleBioCheck(ctx, numbersToCheck) {
    if (waConnectionStatus !== 'open') return ctx.reply(config.message.waNotConnected, { parse_mode: 'Markdown' });
    if (numbersToCheck.length === 0) return ctx.reply("Nomornya mana, bos?");

    await ctx.reply(`Otw boskuu... ngecek ${numbersToCheck.length} nomor.`);

    let withBio = [], noBio = [], notRegistered = [];

    const jids = numbersToCheck.map(num => num.trim() + '@s.whatsapp.net');
    const existenceResults = await waClient.onWhatsApp(...jids);
    
    const registeredJids = [];
    existenceResults.forEach(res => {
        if (res.exists) {
            registeredJids.push(res.jid);
        } else {
            notRegistered.push(res.jid.split('@')[0]);
        }
    });
    const registeredNumbers = registeredJids.map(jid => jid.split('@')[0]);

    if (registeredNumbers.length > 0) {
        const batchSize = config.settings.cekBioBatchSize || 15;
        for (let i = 0; i < registeredNumbers.length; i += batchSize) {
            const batch = registeredNumbers.slice(i, i + batchSize);
            const promises = batch.map(async (nomor) => {
                const jid = nomor.trim() + '@s.whatsapp.net';
                try {
                    const statusResult = await waClient.fetchStatus(jid);
                    let bioText = null, setAtText = null;
                    if (Array.isArray(statusResult) && statusResult.length > 0) {
                        const data = statusResult[0];
                        if (data) {
                            if (typeof data.status === 'string') bioText = data.status;
                            else if (typeof data.status === 'object' && data.status !== null) bioText = data.status.text || data.status.status;
                            setAtText = data.setAt || (data.status && data.status.setAt);
                        }
                    }
                    if (bioText && bioText.trim() !== '') {
                        withBio.push({ nomor, bio: bioText, setAt: setAtText });
                    } else { noBio.push(nomor); }
                } catch (e) {
                    notRegistered.push(nomor.trim());
                }
            });
            await Promise.allSettled(promises);
            await sleep(1000);
        }
    }

    let fileContent = "HASIL CEK BIO SEMUA USER\n\n";
    fileContent += `✅ Total nomor dicek : ${numbersToCheck.length}\n`;
    fileContent += `📳 Dengan Bio       : ${withBio.length}\n`;
    fileContent += `📵 Tanpa Bio        : ${noBio.length}\n`;
    fileContent += `🚫 Tidak Terdaftar  : ${notRegistered.length}\n\n`;
    if (withBio.length > 0) {
        fileContent += `----------------------------------------\n\n`;
        fileContent += `✅ NOMOR DENGAN BIO (${withBio.length})\n\n`;
        const groupedByYear = withBio.reduce((acc, item) => {
            const year = new Date(item.setAt).getFullYear() || "Tahun Tidak Diketahui";
            if (!acc[year]) acc[year] = []; acc[year].push(item);
            return acc;
        }, {});
        const sortedYears = Object.keys(groupedByYear).sort();
        for (const year of sortedYears) {
            fileContent += `Tahun ${year}\n\n`;
            groupedByYear[year].sort((a, b) => new Date(a.setAt) - new Date(b.setAt)).forEach(item => {
                const date = new Date(item.setAt);
                let formattedDate = '...';
                if (!isNaN(date)) {
                    const datePart = date.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    const timePart = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\./g, ':');
                    formattedDate = `${datePart}, ${timePart.replace(/:/g, '.')}`;
                }
                fileContent += `└─ 📅 ${item.nomor}\n   └─ 📝 "${item.bio}"\n      └─ ⏰ ${formattedDate}\n\n`;
            });
        }
    }
    fileContent += `----------------------------------------\n\n`;
    fileContent += `📵 NOMOR TANPA BIO / PRIVASI (${noBio.length})\n\n`;
    if (noBio.length > 0) {
        noBio.forEach(nomor => { fileContent += `${nomor}\n`; });
    } else { fileContent += `(Kosong)\n`; }
    fileContent += `\n`;

    const filePath = `./hasil_cekbio_${ctx.from.id}.txt`;
    fs.writeFileSync(filePath, fileContent);
    await ctx.replyWithDocument({ source: filePath }, { caption: "Nih hasilnya boskuu." });
    fs.unlinkSync(filePath);
}

const bot = new Telegraf(config.telegramBotToken);
const checkAccess = (level) => async (ctx, next) => {
    const userId = ctx.from.id;
    if (level === 'owner' && userId !== config.ownerId) {
        return ctx.reply(config.message.owner, { parse_mode: 'Markdown' });
    }
    if (level === 'premium') {
        const isPremium = getPremiumUsers().includes(userId);
        if (userId !== config.ownerId && !isPremium) {
            return ctx.reply(config.message.premium, { parse_mode: 'Markdown' });
        }
    }
    await next();
};

bot.command('start', (ctx) => {
    const userName = ctx.from.first_name;
    const caption = `✨ *Wih, halo ${userName}!*
Gw siap bantu lu cek bio & info WhatsApp.

- - - - - - - - - - - - - - - - - - - - -

🚀 *FITUR UTAMA*
/cekbio <nomor1> <nomor2> ...
/cekbiotxt (reply file .txt)

👑 *PUNYA OWNER*
/pairing <nomor>
/addakses <id_user>
/delakses <id_user>
/listallakses

- - - - - - - - - - - - - - - - - - - - -`;
    ctx.replyWithPhoto({ url: config.photoStart }, { caption: caption, parse_mode: 'Markdown' });
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
    const phoneNumber = ctx.message.text.split(' ')[1]?.replace(/[^0-9]/g, '');
    if (!phoneNumber) return ctx.reply("Formatnya salah bos.\nContoh: /pairing 62812...");
    if (!waClient) return ctx.reply("Koneksi WA lagi down, sabar bentar.");
    try {
        await ctx.reply("Otw minta kode pairing...");
        const code = await waClient.requestPairingCode(phoneNumber);
        await ctx.reply(`📲 Nih kodenya bos: *${code}*\n\nMasukin di WA lu:\n*Tautkan Perangkat > Tautkan dengan nomor telepon*`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Gagal pairing:", e);
        await ctx.reply(`Gagal minta pairing code, bos. Coba lagi ntar.`);
    }
});

bot.command('cekbio', checkAccess('premium'), async (ctx) => {
    const numbersToCheck = ctx.message.text.split(' ').slice(1).join(' ').match(/\d+/g) || [];
    await handleBioCheck(ctx, numbersToCheck);
});

bot.command('cekbiotxt', checkAccess('premium'), async (ctx) => {
    if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.document) {
        return ctx.reply("Reply file .txt nya dulu, bos.");
    }
    const doc = ctx.message.reply_to_message.document;
    if (doc.mime_type !== 'text/plain') { return ctx.reply("Filenya harus .txt, jangan yang lain."); }
    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const response = await axios.get(fileLink.href);
        const numbersToCheck = response.data.match(/\d+/g) || [];
        await handleBioCheck(ctx, numbersToCheck);
    } catch (error) {
        console.error("Gagal proses file:", error);
        ctx.reply("Gagal ngambil nomor dari file, coba lagi.");
    }
});

bot.command(['addakses', 'delakses'], checkAccess('owner'), (ctx) => {
    const command = ctx.message.text.split(' ')[0].slice(1);
    const targetId = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(targetId)) return ctx.reply("ID-nya angka, bos.");
    let premiumUsers = getPremiumUsers();
    if (command === 'addakses') {
        if (premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} udah premium dari kapan tau.`);
        premiumUsers.push(targetId);
        savePremiumUsers(premiumUsers);
        ctx.reply(`✅ Siap! ID ${targetId} sekarang jadi member premium.`);
    } else {
        if (!premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} emang bukan premium, bos.`);
        const newUsers = premiumUsers.filter(id => id !== targetId);
        savePremiumUsers(newUsers);
        ctx.reply(`✅ Oke, ID ${targetId} udah gw cabut premiumnya.`);
    }
});

bot.command('listallakses', checkAccess('owner'), (ctx) => {
    const premiumUsers = getPremiumUsers();
    if (premiumUsers.length === 0) return ctx.reply("Belum ada member premium, bos.");
    let text = "*Nih daftar member premium:*\n";
    premiumUsers.forEach(id => { text += `- ${id}\n`; });
    ctx.reply(text, { parse_mode: 'Markdown' });
});

(async () => {
    await startWhatsAppClient();
    bot.launch();
    console.log('Bot Telegram OTW!');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));