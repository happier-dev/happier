import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

import { db, initDbPostgres } from "@/storage/db";

import { assertAllOriginAutomationRunMigrationToE2ee } from "./automationAccountEncryptionMigrationRuns.testkit";

const provider = String(
    process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "",
).trim().toLowerCase();

describe.skipIf(provider !== "postgres" && provider !== "postgresql")(
    "PostgreSQL Automation all-origin Account-transition participant contract",
    () => {
        let dbConnected = false;
        const accountIds = new Set<string>();

        beforeAll(async () => {
            if (!process.env.DATABASE_URL) {
                throw new Error(
                    "Missing DATABASE_URL (required for the PostgreSQL all-origin Automation transition participant contract).",
                );
            }
            initDbPostgres();
            await db.$connect();
            dbConnected = true;
        });

        afterEach(async () => {
            for (const accountId of accountIds) {
                await db.accountChange.deleteMany({ where: { accountId } });
                await db.automationRunEvent.deleteMany({
                    where: { run: { accountId } },
                });
                await db.automationRun.deleteMany({ where: { accountId } });
                await db.automationAssignment.deleteMany({
                    where: { automation: { accountId } },
                });
                await db.automation.deleteMany({ where: { accountId } });
                await db.machine.deleteMany({ where: { accountId } });
                await db.account.deleteMany({ where: { id: accountId } });
            }
            accountIds.clear();
        });

        afterAll(async () => {
            if (dbConnected) await db.$disconnect();
        });

        it("uses the shared all-origin retained-Run migration-participant scenario", async () => {
            await assertAllOriginAutomationRunMigrationToE2ee({
                onAccountCreated: (accountId) => accountIds.add(accountId),
            });
        });
    },
);
