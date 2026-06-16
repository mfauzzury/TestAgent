#!/usr/bin/env node
"use strict";

require("dotenv/config");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient: SqlitePrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");

const DEFAULT_EMAIL = "admin@testagent.local";
const MIN_LEN = 6;

function parseArgs() {
  let email = (process.env.ADMIN_RESET_EMAIL || "").trim() || DEFAULT_EMAIL;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--email=")) {
      email = a.slice("--email=".length).trim().toLowerCase();
    } else if (a === "--help" || a === "-h") {
      console.log(`
Reset admin/user password.

Use one of:
  ADMIN_RESET_PASSWORD='new-secret' node scripts/reset-admin-password.js
  ADMIN_RESET_PASSWORD_FILE=/run/secrets/admin_password node scripts/reset-admin-password.js

Optional:
  ADMIN_RESET_EMAIL=admin@testagent.local
  --email=admin@testagent.local
`);
      process.exit(0);
    }
  }
  return { email };
}

function readSecretFromFile() {
  const p = (process.env.ADMIN_RESET_PASSWORD_FILE || "").trim();
  if (!p) return undefined;
  if (!fs.existsSync(p)) throw new Error(`ADMIN_RESET_PASSWORD_FILE not found: ${p}`);
  return (fs.readFileSync(p, "utf-8").split(/\r?\n/)[0] || "").trim();
}

function readDbSettingsSync() {
  const p = path.join(process.cwd(), "data", "app-settings.json");
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const j = JSON.parse(raw);
    return { dbEnabled: !!j.dbEnabled, dbUrl: String(j.dbUrl || "").trim() };
  } catch {
    return null;
  }
}

function sqliteFileUrl() {
  const pick = (v) => (typeof v === "string" && v.trim().startsWith("file:") ? v.trim() : undefined);
  return (
    pick(process.env.SQLITE_DATABASE_URL) ||
    pick(process.env.DATABASE_URL) ||
    `file:${path.join(process.cwd(), "data/testAgent.db")}`
  );
}

function mysqlUrlForRuntime() {
  const cfg = readDbSettingsSync();
  if (cfg && !cfg.dbEnabled) return null;
  if (cfg && cfg.dbEnabled && cfg.dbUrl) return cfg.dbUrl;
  const envUrl = (process.env.DATABASE_URL || "").trim();
  if (/^(mysql|mariadb):\/\//i.test(envUrl)) return envUrl;
  return null;
}

async function makeClient() {
  const mysqlUrl = mysqlUrlForRuntime();
  if (mysqlUrl) {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({ uri: mysqlUrl, connectTimeout: 3000 });
    await conn.query("SELECT 1");
    await conn.end();

    const mysqlClientModule = await import("../prisma/generated/mysql-client");
    const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
    const adapter = new PrismaMariaDb(mysqlUrl);
    const client = new mysqlClientModule.PrismaClient({ adapter });
    console.log("[db] active backend: MySQL");
    return client;
  }

  const adapter = new PrismaBetterSqlite3({ url: sqliteFileUrl() });
  const client = new SqlitePrismaClient({ adapter });
  console.log("[db] active backend: SQLite");
  return client;
}

async function main() {
  const { email: targetEmail } = parseArgs();
  const plain = ((process.env.ADMIN_RESET_PASSWORD || "").trim() || readSecretFromFile() || "").trim();
  if (!plain) {
    throw new Error("Set ADMIN_RESET_PASSWORD or ADMIN_RESET_PASSWORD_FILE (no plaintext password in CLI args).");
  }
  if (plain.length < MIN_LEN) {
    throw new Error(`Password must be at least ${MIN_LEN} characters.`);
  }

  const prisma = await makeClient();
  try {
    const email = targetEmail.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`No user with email: ${email}`);
    const passwordHash = await bcrypt.hash(plain, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    console.log(`Password updated for ${email} (${user.role}).`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

