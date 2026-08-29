import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import {
    registerConnectedAccountAttemptTransactionRoutes,
} from "./connectedAccountAttemptTransactions/registerConnectedAccountAttemptTransactionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();

    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported connected-account attempt contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql)`,
    );
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // This test-only auth adapter is the Fastify boundary; the registered route and
    // its production repository continue to run unmocked below.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    registerConnectedAccountAttemptTransactionRoutes(typed);
    return trackApp(typed);
}

function measuredOpaqueEnvelope(params: Readonly<{
    marker: string;
    ciphertextBytes: number;
}>): Readonly<{ t: "encrypted"; c: string }> {
    const prefix = `${params.marker}:`;
    const paddingBytes = params.ciphertextBytes - new TextEncoder().encode(prefix).byteLength;
    if (paddingBytes < 0) {
        throw new Error("Connected-account attempt contract marker exceeds its measured payload budget.");
    }
    return Object.freeze({
        t: "encrypted" as const,
        c: `${prefix}${"x".repeat(paddingBytes)}`,
    });
}

describe("Connected Account attempt transaction provider db contract", () => {
    const provider = resolveContractProviderFromEnv();
    const cleanupMarkers = new Set<string>();
    const cleanupAccountIds = new Set<string>();
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for connected-account attempt db contract tests).");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        await closeTrackedApps();
        if (!dbConnected) return;
        for (const marker of cleanupMarkers) {
            await db.repeatKey.deleteMany({ where: { value: { contains: marker } } });
        }
        for (const accountId of cleanupAccountIds) {
            await db.account.deleteMany({ where: { id: accountId } });
        }
        cleanupMarkers.clear();
        cleanupAccountIds.clear();
    });

    afterAll(async () => {
        await closeTrackedApps();
        if (dbConnected) {
            await db.$disconnect();
        }
    });

    it("round-trips measured OAuth and device attempt payloads through RepeatKey with CAS and exact delete", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        cleanupAccountIds.add(account.id);
        const app = createTestApp();
        await app.ready();

        for (const scenario of [
            { kind: "oauth" as const, ciphertextBytes: 1_200 },
            { kind: "device" as const, ciphertextBytes: 1_300 },
        ]) {
            const marker = `connected-attempt-${provider}-${scenario.kind}-${randomUUID()}`;
            cleanupMarkers.add(marker);
            const attemptId = `${scenario.kind}-${randomUUID()}`;
            const url = `/v2/connect/connected-account-attempt-transactions/${scenario.kind}/${attemptId}`;
            const expiresAtMs = Date.now() + 15 * 60_000;
            const initialContent = measuredOpaqueEnvelope({
                marker,
                ciphertextBytes: scenario.ciphertextBytes,
            });
            const replacementContent = measuredOpaqueEnvelope({
                marker: `${marker}-replacement`,
                ciphertextBytes: scenario.ciphertextBytes,
            });
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            };

            expect(new TextEncoder().encode(initialContent.c).byteLength)
                .toBe(scenario.ciphertextBytes);
            expect(new TextEncoder().encode(replacementContent.c).byteLength)
                .toBe(scenario.ciphertextBytes);

            const created = await app.inject({
                method: "POST",
                url,
                headers,
                payload: { content: initialContent, expiresAtMs },
            });
            expect(created.statusCode).toBe(200);
            expect(created.json()).toEqual({
                revision: 1,
                content: initialContent,
                expiresAtMs,
            });

            const stored = await db.repeatKey.findFirstOrThrow({
                where: { value: { contains: marker } },
                select: { value: true },
            });
            expect(stored.value).toContain(initialContent.c);

            const read = await app.inject({
                method: "GET",
                url,
                headers,
            });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual(created.json());

            const staleReplace = await app.inject({
                method: "PATCH",
                url,
                headers,
                payload: {
                    expectedRevision: 2,
                    content: replacementContent,
                    expiresAtMs: expiresAtMs + 1_000,
                },
            });
            expect(staleReplace.statusCode).toBe(409);
            expect(staleReplace.json()).toEqual({
                error: "connected_account_attempt_transaction_conflict",
            });

            const replaced = await app.inject({
                method: "PATCH",
                url,
                headers,
                payload: {
                    expectedRevision: 1,
                    content: replacementContent,
                    expiresAtMs: expiresAtMs + 1_000,
                },
            });
            expect(replaced.statusCode).toBe(200);
            expect(replaced.json()).toEqual({
                revision: 2,
                content: replacementContent,
                expiresAtMs: expiresAtMs + 1_000,
            });

            const staleDelete = await app.inject({
                method: "DELETE",
                url,
                headers,
                payload: { expectedRevision: 1 },
            });
            expect(staleDelete.statusCode).toBe(409);
            expect(staleDelete.json()).toEqual({
                error: "connected_account_attempt_transaction_conflict",
            });

            const deleted = await app.inject({
                method: "DELETE",
                url,
                headers,
                payload: { expectedRevision: 2 },
            });
            expect(deleted.statusCode).toBe(200);
            expect(deleted.json()).toEqual({ status: "deleted" });

            const missing = await app.inject({
                method: "GET",
                url,
                headers,
            });
            expect(missing.statusCode).toBe(404);
            expect(missing.json()).toEqual({
                error: "connected_account_attempt_transaction_not_found",
            });
        }
    });

    it("commits concurrent distinct exact-key admissions without a cross-domain Account fence", async () => {
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        cleanupAccountIds.add(account.id);
        const app = createTestApp();
        await app.ready();
        const marker = `connected-attempt-${provider}-concurrency-${randomUUID()}`;
        cleanupMarkers.add(marker);
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": account.id,
        };
        const responses = await Promise.all(
            Array.from({ length: 20 }, (_, index) => app.inject({
                method: "POST",
                url: `/v2/connect/connected-account-attempt-transactions/oauth/concurrent-${index}`,
                headers,
                payload: {
                    content: measuredOpaqueEnvelope({
                        marker: `${marker}-${index}`,
                        ciphertextBytes: 1_200,
                    }),
                    expiresAtMs: Date.now() + 15 * 60_000,
                },
            })),
        );
        for (const response of responses) {
            expect(response.statusCode, response.body).toBe(200);
        }
        expect(await db.repeatKey.count({
            where: { value: { contains: marker } },
        })).toBe(20);
    });
});
