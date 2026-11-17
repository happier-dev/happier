import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { createDatabaseIntegrationHarness } from "@/testkit/databaseIntegrationHarness";
import { registerVoiceMintRoute } from "./registerVoiceMintRoute";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Voice mint PostgreSQL-compatible dialect", () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: "voice-mint-dialect-", initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${"a".repeat(32)}`,
                HAPPIER_FEATURE_VOICE__ENABLED: "true", HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: "false",
                ELEVENLABS_API_KEY: "fixture-key", ELEVENLABS_AGENT_ID: "fixture-agent" } });
    });
    afterAll(async () => { await harness?.close(); });

    it.each(["postgres", "pglite"])("holds the account advisory lock before minting with the %s profile", async backend => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const app = createAuthenticatedTestApp();
        registerVoiceMintRoute(app, "/v1/voice/token", undefined);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "fixture-token" }), { status: 200 })));
        const transaction = db.$transaction;
        const heldLocks: number[] = [];
        // Observe the real database at the lease write; the mint handler and advisory SQL stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, name, txReceiver) {
                if (name !== "voiceSessionLease") return Reflect.get(inner, name, txReceiver);
                return new Proxy(inner.voiceSessionLease, { get(delegate, method, delegateReceiver) {
                    if (method !== "create") return Reflect.get(delegate, method, delegateReceiver);
                    return async (...input: Parameters<typeof delegate.create>) => {
                        const locks = await inner.$queryRawUnsafe<Array<{ count: bigint }>>(
                            "SELECT count(*) AS count FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'",
                        );
                        heldLocks.push(Number(locks[0].count));
                        return delegate.create(...input);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        const previous = process.env.HAPPIER_DB_PROVIDER;
        process.env.HAPPIER_DB_PROVIDER = backend;
        try {
            const response = await app.inject({ method: "POST", url: "/v1/voice/token",
                headers: { "x-test-user-id": account.id }, payload: {} });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ allowed: true, token: "fixture-token" });
            expect(heldLocks).toEqual([1]);
            expect(await db.voiceSessionLease.count({ where: { accountId: account.id } })).toBe(1);
        } finally {
            db.$transaction = transaction;
            if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = previous;
            vi.unstubAllGlobals();
            await app.close();
        }
    });
});
