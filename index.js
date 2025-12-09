import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import db from './db.js'

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session')

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Chrome (Linux)', 'Chrome', '121.0.6167.140']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      try { console.clear() } catch {}
      qrcode.generate(qr, { small: true })
      console.log('📱 Escaneie o QR Code acima no WhatsApp')
    }

    if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!')
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log('⚠ Conexão encerrada:', reason || 'Motivo desconhecido')

      if (reason !== 401) {
        console.log('🔁 Tentando reconectar...')
        setTimeout(() => startBot(), 1500)
      } else {
        console.log('❌ Sessão inválida. Apague a pasta "session" e conecte novamente.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg || !msg.message) return

      const chat = msg.key.remoteJid
      const sender = msg.key.participant || msg.key.remoteJid
      const isGroup = chat.endsWith('@g.us')
      if (!isGroup) return

      const text =
        (msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '').trim()

      const groupMetadata = await sock.groupMetadata(chat)
      const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id)
      const isAdmin = admins.includes(sender)

      // ===== BLOQUEIO GLOBAL DE COMANDOS =====
      if (text.startsWith('/')) {
        if (!isAdmin) {
          return sock.sendMessage(chat, { text: '❌ Apenas admins podem usar comandos.' })
        }
      }


      // =============================== //
      // ====== COMANDOS DO BOT ======= //
      // =============================== //

      // ===== MARCAR TODOS =====
      if (text.startsWith('/marcartodos')) {
        if (!isAdmin) return sock.sendMessage(chat, { text: '❌ Apenas admins.' })

        const mentions = groupMetadata.participants.map(p => p.id)

        // Captura o texto após o comando:
        const extraMsg = text.replace('/marcartodos', '').trim()

        // Mensagem final
        const finalText = extraMsg
          ? `🤖📢 MARCANDO TODOS\n${extraMsg}`
          : `🤖📢 MARCANDO TODOS`

        await sock.sendMessage(chat, {
          text: finalText,
          mentions
        })
      }


      // ---------- FECHAR --------------
      if (text === '/fechar') {
        if (!isAdmin) return sock.sendMessage(chat, { text: '❌ Apenas admins.' })
        await sock.groupSettingUpdate(chat, 'announcement')
        sock.sendMessage(chat, { text: '🤖🔒 Grupo fechado — apenas admins podem enviar mensagens.' })
      }

      // ---------- ABRIR ----------------
      if (text === '/abrir') {
        if (!isAdmin) return sock.sendMessage(chat, { text: '❌ Apenas admins.' })
        await sock.groupSettingUpdate(chat, 'not_announcement')
        sock.sendMessage(chat, { text: '🤖✅ Grupo aberto com sucesso.' })
      }

      // ---------- ADDLINK --------------
      if (text.startsWith('/addlink')) {
        if (!isAdmin) return sock.sendMessage(chat, { text: '❌ Apenas admins.' })

        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
        if (!mentioned?.length) return sock.sendMessage(chat, { text: '⚠ Use: /addlink @usuario' })

        for (let user of mentioned) {
          const row = await db.get(
            `SELECT * FROM link_permissoes WHERE grupo = ? AND usuario = ?`,
            [chat, user]
          )

          if (!row) {
            await db.run(
              `INSERT INTO link_permissoes (grupo, usuario) VALUES (?, ?)`,
              [chat, user]
            )
          }
        }

        sock.sendMessage(chat, { text: '✅ Usuário(s) autorizado(s) para enviar links.' })
      }

      // ---------- REMLINK --------------
      if (text.startsWith('/remlink')) {
        if (!isAdmin) return sock.sendMessage(chat, { text: '❌ Apenas admins.' })

        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
        if (!mentioned?.length) return sock.sendMessage(chat, { text: '⚠ Use: /remlink @usuario' })

        for (let user of mentioned) {
          await db.run(
            `DELETE FROM link_permissoes WHERE grupo = ? AND usuario = ?`,
            [chat, user]
          )
        }

        sock.sendMessage(chat, { text: '✅ Permissão removida.' })
      }

      // --------- LISTALINK ------------
      if (text === '/listalink') {
        if (!isAdmin) return sock.sendMessage(chat, { text: '❌ Apenas admins.' })

        const rows = await db.all(
          `SELECT usuario FROM link_permissoes WHERE grupo = ?`,
          [chat]
        )

        if (!rows?.length)
          return sock.sendMessage(chat, { text: '📭 Nenhum usuário autorizado para enviar links.' })

        let txt = '🔗 Autorizados a enviar links:\n\n'
        const mentions = []

        for (let row of rows) {
          txt += `• @${row.usuario.split('@')[0]}\n`
          mentions.push(row.usuario)
        }

        sock.sendMessage(chat, { text: txt, mentions })
      }

      // -------- BLOQUEAR LINKS --------
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
            text: '🚫 Você não tem permissão para enviar links.',
            mentions: [sender]
          })
        }
      }

    } catch (e) {
      console.error('Erro ao processar mensagem:', e)
    }
  })
}

startBot()
