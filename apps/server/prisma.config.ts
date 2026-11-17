import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma 7 reads connection URLs only from here). Every server
 * CLI call passes `--schema` for its dialect and `DATABASE_URL` in its environment; the
 * runtime client never reads this file (it connects through `sources/storage/prismaDriverAdapters.ts`).
 */
export default defineConfig({
    datasource: { url: process.env.DATABASE_URL ?? "" },
});
