import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys'
import P from 'pino'
import qrcode from 'qrcode'                 // <── CORRETO
import qrcode_terminal from 'qrcode-terminal'
import db from './db.js'

const OWNER_NUMBER = "16198702091@s.whatsapp.net"   // seu número

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session')

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Chrome', '121.0.6167.140']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.clear()
      qrcode_terminal.generate(qr, { small: true })
      console.log("🔐 QR GERADO!")

      try {
        const qrBuffer = await qrcode.toBuffer(qr)   // <── AGORA FUNCIONA

        await sock.sendMessage(OWNER_NUMBER, {
          image: qrBuffer,
          caption: "📲 *Seu QR Code está pronto!*"
        })

      } catch (err) {
        console.error("Erro ao enviar QR:", err)
      }
    }

    if (connection === "open") {
      console.log("✅ Bot conectado!")
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log("⚠ Conexão encerrada:", reason || "Motivo desconhecido")

      if (reason !== 401) {
        console.log("🔁 Tentando reconectar em 2s...")
        setTimeout(() => startBot(), 2000)
      } else {
        console.log("❌ Sessão inválida! Apague a pasta session.")
      }
    }
  })

  // ------ SISTEMA DE MENSAGENS / COMANDOS ------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg?.message) return

      const chat = msg.key.remoteJid
      const sender = msg.key.participant || msg.key.remoteJid
      if (!chat.endsWith('@g.us')) return

      const text =
        (msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '').trim()

      const groupMetadata = await sock.groupMetadata(chat)
      const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id)
      const isAdmin = admins.includes(sender)

      // ===== BLOQUEIO GLOBAL DE COMANDOS =====
      if (text.startsWith('/') && !isAdmin) {
        return sock.sendMessage(chat, { text: '❌ Apenas admins podem usar comandos.' })
      }

      // =======================
      // MARCAR TODOS
      // =======================
      if (text.startsWith('/marcartodos')) {
        const mentions = groupMetadata.participants.map(p => p.id)
        const extra = text.replace('/marcartodos', '').trim()
        const final = extra ? `🤖📢 MARCANDO TODOS\n${extra}` : `🤖📢 MARCANDO TODOS`

        await sock.sendMessage(chat, { text: final, mentions })
      }

      // FECHAR
      if (text === '/fechar') {
        await sock.groupSettingUpdate(chat, 'announcement')
        sock.sendMessage(chat, { text: '🔒 Grupo fechado!' })
      }

      // ABRIR
      if (text === '/abrir') {
        await sock.groupSettingUpdate(chat, 'not_announcement')
        sock.sendMessage(chat, { text: '🔓 Grupo aberto!' })
      }

      // ADDLINK
      if (text.startsWith('/addlink')) {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
        if (!mentioned?.length) return sock.sendMessage(chat, { text: '⚠ Use: /addlink @usuario' })

        for (let user of mentioned) {
          const row = await db.get(
            `SELECT 1 FROM link_permissoes WHERE grupo = ? AND usuario = ?`,
            [chat, user]
          )

          if (!row) {
            await db.run(
              `INSERT INTO link_permissoes (grupo, usuario) VALUES (?, ?)`,
              [chat, user]
            )
          }
        }

        sock.sendMessage(chat, { text: '✅ Usuário autorizado!' })
      }

      // REMLINK
      if (text.startsWith('/remlink')) {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
        if (!mentioned?.length) return sock.sendMessage(chat, { text: '⚠ Use: /remlink @usuario' })

        for (let user of mentioned) {
          await db.run(
            `DELETE FROM link_permissoes WHERE grupo = ? AND usuario = ?`,
            [chat, user]
          )
        }

        sock.sendMessage(chat, { text: '❎ Permissão removida.' })
      }

      // LISTALINK
      if (text === '/listalink') {
        const rows = await db.all(`SELECT usuario FROM link_permissoes WHERE grupo = ?`, [chat])

        if (!rows.length) {
          return sock.sendMessage(chat, { text: '📭 Nenhum usuário autorizado.' })
        }

        let txt = '🔗 Autorizados:\n\n'
        const mentions = []

        for (let row of rows) {
          txt += `• @${row.usuario.split('@')[0]}\n`
          mentions.push(row.usuario)
        }

        sock.sendMessage(chat, { text: txt, mentions })
      }

      // BLOQUEAR LINKS
      const linkRegex = /(https?:\/\/|www\.)/gi

      if (linkRegex.test(text) && !isAdmin) {
        const row = await db.get(
          `SELECT 1 FROM link_permissoes WHERE grupo = ? AND usuario = ?`,
          [chat, sender]
        )

        if (!row) {
          try {
            await sock.sendMessage(chat, {
              delete: {
                remoteJid: chat,
                fromMe: false,
                id: msg.key.id,
                participant: sender
              }
            })
          } catch {}

          sock.sendMessage(chat, {
            text: '🚫 Você não pode enviar links.',
            mentions: [sender]
          })
        }
      }

    } catch (err) {
      console.error("Erro:", err)
    }
  })
}

startBot()
