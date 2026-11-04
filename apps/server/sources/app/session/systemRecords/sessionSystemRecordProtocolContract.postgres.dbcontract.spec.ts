import { PrismaClient, type Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { auditSessionSystemRecordAddressesPage } from "./backfillSessionSystemRecordAddresses";
import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from "./sessionSystemRecordProtocolContract";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("System Records activation SQL cost", () => {
    const statements: string[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, "query">;
    let resolveBarrier: (() => void) | undefined;

    async function drainQueryEvents(): Promise<void> {
        const observed = new Promise<void>(resolve => { resolveBarrier = resolve; });
        try {
            await Promise.all([client.$queryRaw`SELECT 1 AS "activation_cost_barrier"`, observed]);
        } finally {
            resolveBarrier = undefined;
        }
    }

    beforeAll(async () => {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        client.$on("query", event => {
            if (event.query.includes('"activation_cost_barrier"')) resolveBarrier?.();
            else statements.push(event.query);
        });
        await client.$connect();
    });

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await client?.$disconnect();
    });

    it("reads one migration fact and zero inventory pages with empty and populated storage", async () => {
        const account = await client.account.create({ data: { encryptionMode: "plain" } });
        const session = await client.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const costs: Array<{ recordCount: number; statements: number; inventoryPages: number }> = [];
        try {
            for (const recordCount of [0, 1001]) {
                if (recordCount > 0) {
                    await client.sessionSystemRecord.createMany({ data: Array.from({ length: recordCount }, (_, index) => {
                        const localId = `activation-cost-${index}`;
                        return {
                            accountId: account.id, sessionId: session.id,
                            ownerKind: "host", pluginId: null, namespace: "memory", kind: "synopsis.v1", localId,
                            ...deriveSessionSystemRecordAddressKeys({ ownerKind: "host", pluginId: null, namespace: "memory", localId }),
                            content: { t: "plain", v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "fixture" } },
                        };
                    }) });
                }
                await drainQueryEvents();
                statements.length = 0;
                // Measure the existing migration audit that startup formerly
                // repeated, on the same rows/client as activation below.
                const auditStartedAt = performance.now();
                let afterId: string | undefined;
                let auditPages = 0;
                do {
                    const audit = await auditSessionSystemRecordAddressesPage({ db: client, afterId });
                    expect(audit.nullRows).toBe(0);
                    expect(audit.mismatchedRows).toBe(0);
                    auditPages += 1;
                    afterId = audit.nextAfterId ?? undefined;
                } while (afterId !== undefined);
                const auditElapsedMs = performance.now() - auditStartedAt;
                await drainQueryEvents();
                const auditStatements = statements.length;
                statements.length = 0;
                const startedAt = performance.now();
                await expect(initializeSessionSystemRecordsProtocolV1Activation(client)).resolves.toBe(true);
                const elapsedMs = performance.now() - startedAt;
                await drainQueryEvents();
                const inventoryPages = statements.filter(query => query.includes('"SessionSystemRecord"')).length;
                console.info(JSON.stringify({ recordCount, auditPages, auditStatements, auditElapsedMs,
                    statements: statements.length, inventoryPages, elapsedMs }));
                costs.push({ recordCount, statements: statements.length, inventoryPages });
                expect(statements.some(query => query.includes("_prisma_migrations"))).toBe(true);
            }
            expect(costs).toEqual([
                { recordCount: 0, statements: 1, inventoryPages: 0 },
                { recordCount: 1001, statements: 1, inventoryPages: 0 },
            ]);
        } finally {
            await client.session.delete({ where: { id: session.id } });
            await client.account.delete({ where: { id: account.id } });
        }
    });
});
