# syntax=docker/dockerfile:1
# Test Agent — API + React UI + Playwright runner

# ─── Build API (tsc) + client (Vite) ─────────────────────────────────────────
FROM node:20-bookworm AS builder
# Avoid /app — some PaaS default volume mounts wipe /app and hide baked dist/node_modules.
WORKDIR /srv/app

COPY package.json package-lock.json ./
RUN npm ci

COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client

COPY prisma ./prisma
COPY prisma.config.ts prisma.mysql.config.ts tsconfig.json playwright.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY client ./client
COPY public ./public

# SQLite client (default) + MySQL client (src/db.ts); dummy URL — generate does not open a connection.
RUN npx prisma generate \
    && MYSQL_DATABASE_URL="mysql://build:build@127.0.0.1:3306/build" npx prisma generate --config prisma.mysql.config.ts \
    && npm run build

# ─── Production runtime ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /srv/app

ENV NODE_ENV=production

# better-sqlite3 needs a compile step; Playwright will add Chromium + OS libs via CLI below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts prisma.mysql.config.ts ./

RUN npm ci --omit=dev \
    && npx prisma generate \
    && MYSQL_DATABASE_URL="mysql://build:build@127.0.0.1:3306/build" npx prisma generate --config prisma.mysql.config.ts \
    && npm rebuild better-sqlite3 \
    && npx playwright install-deps chromium \
    && npx playwright install chromium \
    && apt-get update && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=builder /srv/app/dist ./dist
COPY --from=builder /srv/app/client/dist ./client/dist
COPY --from=builder /srv/app/scripts ./scripts
COPY --from=builder /srv/app/src ./src
COPY --from=builder /srv/app/tsconfig.json ./tsconfig.json
COPY playwright.config.ts ./
COPY public ./public

RUN mkdir -p data playwright-reports test-results generated-tests

EXPOSE 4000
ENV PORT=4000

# Migrate SQLite/MySQL on boot, then start compiled server (not ts-node).
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]
