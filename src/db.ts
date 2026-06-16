import "dotenv/config";
import path from "path";
import fs from "fs";
import { PrismaClient } from "@prisma/client";

const DEFAULT_MYSQL_URL = "mysql://kerisi:kerisi123@43.217.187.42:4151/testagent";

let _client: any = null;
export const prisma = new Proxy({} as PrismaClient, {
  get(_t, prop) {
    if (!_client) throw new Error("DB not initialized — call initDb() before using prisma");
    const v = (_client as any)[prop];
    return typeof v === "function" ? v.bind(_client) : v;
  },
}) as PrismaClient;

export type ActiveBackend = "mysql" | "sqlite";
let _active: ActiveBackend = "mysql";
export const getActiveBackend = (): ActiveBackend => _active;

function readDbUrlSync(): string {
  const p = path.join(process.cwd(), "data", "app-settings.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return j.dbUrl || DEFAULT_MYSQL_URL;
  } catch {
    return DEFAULT_MYSQL_URL;
  }
}

async function makeMysqlClient(url: string): Promise<PrismaClient> {
  const { PrismaClient: MysqlPrisma } = await import("../prisma/generated/mysql-client");
  const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
  const adapter = new PrismaMariaDb(url);
  return new MysqlPrisma({ adapter } as any) as unknown as PrismaClient;
}

/**
 * Always connects to MySQL. If the connection fails the server exits —
 * there is no SQLite fallback. Configure the URL in App Settings → Database.
 */
export async function initDb(): Promise<ActiveBackend> {
  const url =
    process.env.MYSQL_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    readDbUrlSync();

  console.log(`[db] connecting to MySQL…`);
  const mysql = await import("mysql2/promise");
  let conn;
  try {
    conn = await mysql.createConnection({ uri: url, connectTimeout: 5000 });
    await conn.query("SELECT 1");
    await conn.end();
  } catch (e) {
    console.error(`[db] ❌ MySQL connection failed: ${(e as Error).message}`);
    console.error(`[db] URL: ${url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`);
    console.error(`[db] Fix the MySQL connection in App Settings → Database, then restart.`);
    process.exit(1);
  }

  _client = await makeMysqlClient(url);
  _active = "mysql";
  console.log("[db] active backend: MySQL");
  return _active;
}
