import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

sqlite3.verbose()

const db = await open({
  filename: './database.db',
  driver: sqlite3.Database
})

await db.exec(`
  CREATE TABLE IF NOT EXISTS link_permissoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo TEXT,
    usuario TEXT
  )
`)

export default db
