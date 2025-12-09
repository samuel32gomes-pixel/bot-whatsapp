import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import P from "pino"
import qrcode from "qrcode-terminal"
import db from "./db.js"

// Coloque aqui seu número em formato WhatsApp JID
const OWNER_NUMBER = "16198702091@s.whatsapp.net"


async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session")

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["Chrome (Linux)", "Chrome", "121.0.6167.140"]
  })

  // Atualiza credenciais
  sock.ev.on("creds.update", saveCreds)


  // =======================================
  //            QR CODE HANDLER
  // =======================================
  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {

    if (qr) {
      console.log("🟦 QR Code gerado! Mostrando no terminal:")
      qrcode.generate(qr, { small: true })

      // Envia o QR como TEXTO no WhatsApp (compatível com Discloud)
      try {
        await sock.sendMessage(OWNER_NUMBER, {
          text: `📲 *Seu QR Code está pronto!*\n\n${qr}`
        })
        console.log("📤 QR enviado para o seu WhatsApp!")
      } catch (err) {
        console.log("⚠ Não foi possível enviar o QR para o WhatsApp:", err)
      }
    }

    if (connection === "open") {
      console.log("✅ Bot conectado com sucesso!")
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log("⚠ Conexão encerrada:", reason || "Motivo desconhecido")

      if (reason !== 401) {
        console.log("🔁 Tentando reconectar...")
        setTimeout(() => startBot(), 2000)
      } else {
        console.log("❌ Sessão inválida. Apague a pasta 'session' e reconecte.")
      }
    }
  })


  // =======================================
  //     RECEBIMENTO E TRATAMENTO DE MSGS
  // =======================================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg || !msg.message) return

      const chat = msg.key.remoteJid
      const sender = msg.key.participant || msg.key.remoteJid
      const isGroup = chat.endsWith("@g.us")
      if (!isGroup) return

      const text =
        (msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "").trim()

      const groupMetadata = await sock.groupMetadata(chat)
      const admins = groupMetadata.participants
        .filter(p => p.admin)
        .map(p => p.id)

      const isAdmin = admins.includes(sender)

      // -----------------------
      // BLOQUEIO GLOBAL
      // -----------------------
      if (text.startsWith("/")) {
        if (!isAdmin) {
          return sock.sendMessage(chat, {
            text: "❌ Apenas admins podem usar comandos."
          })
        }
      }

      // ===============================
      //        /marcartodos
      // ===============================
      if (text.startsWith("/marcartodos")) {
        if (!isAdmin) return

        const mentions = groupMetadata.participants.map(p => p.id)
        const extraMsg = text.replace("/marcartodos", "").trim()

        const finalText = extraMsg
          ? `🤖📢 MARCANDO TODOS\n${extraMsg}`
          : "🤖📢 MARCANDO TODOS"

        await sock.sendMessage(chat, { text: finalText, mentions })
      }

      // ===============================
      //          /fechar
      // ===============================
      if (text === "/fechar") {
        if (!isAdmin) return
        await sock.groupSettingUpdate(chat, "announcement")
        sock.sendMessage(chat, {
          text: "🔒 Grupo fechado — apenas admins enviam msgs."
        })
      }

      // ===============================
      //          /abrir
      // ===============================
      if (text === "/abrir") {
        if (!isAdmin) return
        await sock.groupSettingUpdate(chat, "not_announcement")
        sock.sendMessage(chat, { text: "🔓 Grupo aberto com sucesso." })
      }


      // ===============================
      //          /addlink
      // ===============================
      if (text.startsWith("/addlink")) {
        if (!isAdmin) return

        const mentioned =
          msg.message.extendedTextMessage?.contextInfo?.mentionedJid

        if (!mentioned?.length)
          return sock.sendMessage(chat, { text: "⚠ Use: /addlink @usuario" })

        for (let user of mentioned) {
          const row = await db.get(
            "SELECT * FROM link_permissoes WHERE grupo = ? AND usuario = ?",
            [chat, user]
          )

          if (!row) {
            await db.run(
              "INSERT INTO link_permissoes (grupo, usuario) VALUES (?, ?)",
              [chat, user]
            )
          }
        }

        sock.sendMessage(chat, {
          text: "✅ Usuário(s) autorizado(s) a enviar links."
        })
      }

      // ===============================
      //          /remlink
      // ===============================
      if (text.startsWith("/remlink")) {
        if (!isAdmin) return

        const mentioned =
          msg.message.extendedTextMessage?.contextInfo?.mentionedJid

        if (!mentioned?.length)
          return sock.sendMessage(chat, { text: "⚠ Use: /remlink @usuario" })

        for (let user of mentioned) {
          await db.run(
            "DELETE FROM link_permissoes WHERE grupo = ? AND usuario = ?",
            [chat, user]
          )
        }

        sock.sendMessage(chat, { text: "❎ Permissão removida." })
      }


      // ===============================
      //          /listalink
      // ===============================
      if (text === "/listalink") {
        if (!isAdmin) return

        const rows = await db.all(
          "SELECT usuario FROM link_permissoes WHERE grupo = ?",
          [chat]
        )

        if (!rows?.length)
          return sock.sendMessage(chat, {
            text: "📭 Nenhum usuário autorizado para enviar links."
          })

        let txt = "🔗 Autorizados a enviar links:\n\n"
        const mentions = []

        for (let row of rows) {
          txt += `• @${row.usuario.split("@")[0]}\n`
          mentions.push(row.usuario)
        }

        sock.sendMessage(chat, { text: txt, mentions })
      }


      // ===============================
      // BLOQUEAR LINKS AUTOMATICAMENTE
      // ===============================
      const linkRegex = /(https?:\/\/|www\.)/gi

      if (linkRegex.test(text) && !isAdmin) {
        const row = await db.get(
          "SELECT 1 FROM link_permissoes WHERE grupo = ? AND usuario = ?",
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
            text: "🚫 Você não tem permissão para enviar links.",
            mentions: [sender]
          })
        }
      }

    } catch (e) {
      console.error("Erro ao processar mensagem:", e)
    }
  })
}

// Inicia o bot
startBot()
