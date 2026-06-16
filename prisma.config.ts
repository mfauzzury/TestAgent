import "dotenv/config";
import { defineConfig } from "prisma/config";
import path from "path";

/** SQLite tooling requires `file:` URLs. PaaS (e.g. Coolify) often sets DATABASE_URL to MySQL — ignore non-file values. */
function sqliteDatasourceUrl(): string {
  const pick = (v: string | undefined) =>
    v?.trim().startsWith("file:") ? v.trim() : undefined;
  return (
    pick(process.env["SQLITE_DATABASE_URL"]) ??
    pick(process.env["DATABASE_URL"]) ??
    `file:${path.join(process.cwd(), "data/testAgent.db")}`
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: sqliteDatasourceUrl(),
  },
});
