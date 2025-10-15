// index.js - versi stabil untuk Termux
console.log('Memulai bot...');

const { Telegraf } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');

// pastikan lo punya file config.js di root
// contoh config.js ada di instruksi
const config = require('./config');

const premiumPath = './premium.json';

// util
const getPremiumUsers = () => {
  try { return JSON.parse(fs.readFileSync(premiumPath, 'utf8')); }
  catch (e) { fs.writeFileSync(premiumPath, '[]'); return []; }
};
const savePremiumUsers = (users) => fs.writeFileSync(premiumPath, JSON.stringify(users, null, 2));
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

let waClient = null;
let waConnectionStatus = 'closed';

// START WA CLIENT
async function startWhatsAppClient() {
  console.log("Mencoba memulai koneksi WhatsApp...");
  try {
    // pastikan folder session ada / bisa dibuat
    try { if (!fs.existsSync(config.sessionName)) fs.mkdirSync(config.sessionName); } catch (e) {}

    const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);

    waClient = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true, // penting: tampilkan QR di terminal Termux
      auth: state,
      browser: [config.settings?.namabot || 'CekBioBot', 'Termux', '1.0.0']
    });

    // simpan credentials saat berubah
    if (waClient && waClient.ev) {
      waClient.ev.on('creds.update', saveCreds);

      waClient.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        waConnectionStatus = connection;
        if (qr) console.log('📱 QR code ter-generate — scan dari WhatsApp (Lihat terminal).');

        if (connection === 'close') {
          const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const shouldReconnect = reason !== DisconnectReason.loggedOut;
          console.log('Koneksi WA tertutup. reason:', new Boom(lastDisconnect?.error).message, 'reconnect?', shouldReconnect);

          if (!shouldReconnect) {
            console.log('Sesi ter-logout permanen. Menghapus session untuk pairing ulang...');
            try { fs.rmSync(config.sessionName, { recursive: true, force: true }); } catch (e) { console.error('Gagal hapus session:', e.message); }
            waClient = null;
          } else {
            // reconnect sedikit delay
            setTimeout(() => {
              startWhatsAppClient().catch(err => console.error('Reconnect error:', err));
            }, 5000);
          }
        } else if (connection === 'open') {
          console.log('✅ Berhasil tersambung ke WhatsApp!');
        }
      });
    } else {
      console.warn('waClient atau waClient.ev undefined — coba restart proses.');
    }
  } catch (err) {
    console.error('Error inisialisasi WhatsApp client:', err && err.message ? err.message : err);
    await sleep(5000);
    startWhatsAppClient().catch(e => console.error('Gagal restart WA client:', e));
  }
}

// HANDLE CEK BIO (aman)
async function handleBioCheck(ctx, numbersToCheck) {
  try {
    if (waConnectionStatus !== 'open') return ctx.reply(config.message.waNotConnected || 'WhatsApp belum tersambung.');
    if (!Array.isArray(numbersToCheck) || numbersToCheck.length === 0) return ctx.reply('Nomornya mana, bos?');

    await ctx.reply(`Otw boskuu... ngecek ${numbersToCheck.length} nomor.`);

    let withBio = [], noBio = [], notRegistered = [];

    const jids = numbersToCheck.map(num => num.trim() + '@s.whatsapp.net');
    let existenceResults = [];
    try {
      // some versions of bailey return array per jid, others single — handle both
      existenceResults = await waClient.onWhatsApp(...jids);
    } catch (e) {
      console.error('Error onWhatsApp:', e?.message || e);
      return ctx.reply('Gagal cek nomor (onWhatsApp). Coba lagi nanti.');
    }

    // normalize results
    const registeredJids = [];
    if (Array.isArray(existenceResults)) {
      existenceResults.forEach(res => {
        if (res && res.exists) registeredJids.push(res.jid);
        else if (res && res.jid) notRegistered.push(res.jid.split('@')[0]);
      });
    }

    const registeredNumbers = registeredJids.map(jid => jid.split('@')[0]);

    if (registeredNumbers.length > 0) {
      const batchSize = config.settings?.cekBioBatchSize || 10;
      for (let i = 0; i < registeredNumbers.length; i += batchSize) {
        const batch = registeredNumbers.slice(i, i + batchSize);
        const promises = batch.map(async (nomor) => {
          const jid = nomor.trim() + '@s.whatsapp.net';
          try {
            const statusResult = await waClient.fetchStatus(jid);
            // different bailey versions => statusResult may be string or array
            let bioText = null, setAtText = null;
            if (typeof statusResult === 'string') {
              bioText = statusResult;
            } else if (Array.isArray(statusResult) && statusResult.length > 0) {
              const data = statusResult[0];
              if (data) {
                bioText = (typeof data.status === 'string') ? data.status : (data?.status?.text || data?.status?.status);
                setAtText = data.setAt || data?.status?.setAt;
              }
            } else if (statusResult && statusResult.status) {
              bioText = (typeof statusResult.status === 'string') ? statusResult.status : statusResult.status.text;
              setAtText = statusResult.setAt;
            }

            if (bioText && bioText.trim() !== '') {
              withBio.push({ nomor, bio: bioText, setAt: setAtText });
            } else {
              noBio.push(nomor);
            }
          } catch (e) {
            notRegistered.push(nomor);
          }
        });
        await Promise.allSettled(promises);
        await sleep(800);
      }
    }

    // prepare file
    let fileContent = `HASIL CEK BIO\n\nTotal dicek: ${numbersToCheck.length}\nDengan bio: ${withBio.length}\nTanpa bio: ${noBio.length}\nTidak terdaftar: ${notRegistered.length}\n\n`;
    if (withBio.length > 0) {
      fileContent += '=== DENGAN BIO ===\n';
      withBio.forEach(x => fileContent += `${x.nomor} • ${x.bio} • ${x.setAt || '-'}\n`);
      fileContent += '\n';
    }
    if (noBio.length > 0) {
      fileContent += '=== TANPA BIO ===\n' + noBio.join('\n') + '\n\n';
    }
    if (notRegistered.length > 0) {
      fileContent += '=== TIDAK TERDAFTAR ===\n' + notRegistered.join('\n') + '\n\n';
    }

    const filePath = `./hasil_cekbio_${ctx.from.id}.txt`;
    fs.writeFileSync(filePath, fileContent, 'utf8');
    await ctx.replyWithDocument({ source: filePath }, { caption: 'Nih hasilnya boskuu.' });
    try { fs.unlinkSync(filePath); } catch (e) {}
  } catch (err) {
    console.error('handleBioCheck error:', err);
    await ctx.reply('Terjadi error saat proses cek bio.');
  }
}

// TELEGRAM BOT SETUP
const bot = new Telegraf(config.telegramBotToken);

const checkAccess = (level) => async (ctx, next) => {
  const userId = ctx.from?.id;
  if (level === 'owner' && userId !== config.ownerId) return ctx.reply(config.message.owner || 'Lu bukan owner.');
  if (level === 'premium') {
    const isPremium = getPremiumUsers().includes(userId);
    if (userId !== config.ownerId && !isPremium) return ctx.reply(config.message.premium || 'Fitur premium, beli dulu.');
  }
  await next();
};

bot.start((ctx) => {
  const userName = ctx.from?.first_name || 'bos';
  const caption = `✨ Halo ${userName}!\nBot siap bantu cek bio WhatsApp.\n/cekbio <nomor>\n/cekbiotxt (reply .txt)\n/pairing <nomor>`;
  ctx.reply(caption);
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
  const phoneNumber = ctx.message.text.split(' ')[1]?.replace(/[^0-9]/g, '');
  if (!phoneNumber) return ctx.reply('Format salah. Contoh: /pairing 62812...');
  if (!waClient) return ctx.reply('Koneksi WA belum siap. Tunggu sebentar atau lihat QR di terminal.');

  // kalau fungsi requestPairingCode ada, gunakan. Kalau enggak, fallback minta scan QR (terminal)
  try {
    if (typeof waClient.requestPairingCode === 'function') {
      const code = await waClient.requestPairingCode(phoneNumber);
      await ctx.reply(`📲 Kode pairing: *${code}*\nMasukkan di WhatsApp -> Tautkan Perangkat.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('Fitur pairing langsung tidak didukung oleh versi library ini. Silakan scan QR di terminal untuk pairing.');
    }
  } catch (e) {
    console.error('Gagal pairing:', e);
    await ctx.reply('Gagal minta pairing code. Coba scan QR di terminal atau cek logs.');
  }
});

bot.command('cekbio', checkAccess('premium'), async (ctx) => {
  const numbers = (ctx.message.text.match(/\d+/g) || []);
  await handleBioCheck(ctx, numbers);
});

bot.command('cekbiotxt', checkAccess('premium'), async (ctx) => {
  if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.document) return ctx.reply('Reply file .txt dulu.');
  const doc = ctx.message.reply_to_message.document;
  if (doc.mime_type !== 'text/plain') return ctx.reply('Filenya harus .txt');
  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios.get(fileLink.href);
    const numbers = (res.data.match(/\d+/g) || []);
    await handleBioCheck(ctx, numbers);
  } catch (e) {
    console.error('cekbiotxt error:', e);
    await ctx.reply('Gagal ambil file .txt');
  }
});

bot.command(['addakses','delakses'], checkAccess('owner'), (ctx) => {
  const cmd = ctx.message.text.split(' ')[0].slice(1);
  const targetId = parseInt(ctx.message.text.split(' ')[1]);
  if (isNaN(targetId)) return ctx.reply('ID harus angka.');
  let list = getPremiumUsers();
  if (cmd === 'addakses') {
    if (!list.includes(targetId)) { list.push(targetId); savePremiumUsers(list); ctx.reply('ID ditambahkan.'); }
    else ctx.reply('ID sudah ada.');
  } else {
    list = list.filter(x => x !== targetId); savePremiumUsers(list); ctx.reply('ID dihapus.');
  }
});

bot.command('listallakses', checkAccess('owner'), (ctx) => {
  const list = getPremiumUsers();
  if (!list.length) return ctx.reply('Belum ada premium.');
  ctx.reply('Premium:\n' + list.join('\n'));
});

bot.command('resetsession', checkAccess('owner'), async (ctx) => {
  try {
    fs.rmSync(config.sessionName, { recursive: true, force: true });
    await ctx.reply('✅ Session dihapus. Silakan pairing ulang.');
  } catch (e) {
    await ctx.reply('Gagal hapus session: ' + e.message);
  }
});

// start services
(async () => {
  try {
    await startWhatsAppClient();
    bot.launch();
    console.log('Bot Telegram & WA attempt started.');
  } catch (e) {
    console.error('Startup error:', e);
  }
})();

// handle Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));