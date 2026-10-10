import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { db, initDbSqlite, shutdownDbClient } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { holdSqliteWriteLock } from "@/testkit/sqliteWriteLock";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { accountRoutes } from "@/app/api/routes/account/accountRoutes";
import { buildProfilePhysicalKey } from "@/app/kv/accountScopedKv";
import { PROFILE_ROWS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from "@happier-dev/protocol/profiles/profileRecordV1";
import { PROFILE_TRANSFER_ROUTE_V1 } from "@happier-dev/protocol/profiles/profileTransferV1";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { changesRoutes } from "@/app/api/routes/changes/changesRoutes";
import { ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { sealAccountScopedBlobCiphertext } from "@happier-dev/protocol/crypto/accountScopedCipher";
import { recordLegacyUsageReport } from "@/app/usage/usageWriteService";

describe("SQLite read snapshots", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-read-snapshot-", sqliteConnectionLimit: 1, initAuth: true,
            env: {
                HAPPIER_DB_TX_MAX_RETRIES: "0", HAPPIER_DB_TX_MAX_WAIT_MS: "1000",
                HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
        await db.account.create({ data: { id: "snapshot-account", publicKey: "snapshot-key", seq: 1 } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it("reads while a separate process owns the writer lock and the primary connection is waiting for it", async () => {
        const writer = await holdSqliteWriteLock();
        let writeSettled = false;
        const blockedWrite = inTx(tx => tx.account.update({ where: { id: "snapshot-account" }, data: { seq: 2 } }))
            .then(() => null, (error: unknown) => error)
            .finally(() => { writeSettled = true; });
        try {
            const reads = await Promise.all(Array.from({ length: 3 }, () => inTx(
                tx => tx.account.findUniqueOrThrow({ where: { id: "snapshot-account" }, select: { seq: true } }),
                { readOnly: true },
            )));
            expect(reads).toEqual([{ seq: 1 }, { seq: 1 }, { seq: 1 }]);
            expect(writeSettled).toBe(false);
        } finally {
            await writer.release();
            await blockedWrite;
        }
    });

    it("keeps one snapshot across a committed writer, rejects writes, and recovers after callback failure", async () => {
        await db.account.update({ where: { id: "snapshot-account" }, data: { seq: 3 } });
        await inTx(async tx => {
            const read = () => tx.account.findUniqueOrThrow({ where: { id: "snapshot-account" }, select: { seq: true } });
            expect(await read()).toEqual({ seq: 3 });
            await db.account.update({ where: { id: "snapshot-account" }, data: { seq: 4 } });
            expect(await read()).toEqual({ seq: 3 });
        }, { readOnly: true });
        const failure = new Error("read failed");
        await expect(inTx(async () => { throw failure; }, { readOnly: true })).rejects.toBe(failure);
        await expect(inTx(tx => tx.account.update({ where: { id: "snapshot-account" }, data: { seq: 5 } }),
            { readOnly: true })).rejects.toThrow();
        await expect(inTx(tx => tx.account.findUniqueOrThrow({ where: { id: "snapshot-account" }, select: { seq: true } }),
            { readOnly: true })).resolves.toEqual({ seq: 4 });
    });

    it("serves session query, list and detail over HTTP during cross-process contention", async () => {
        const session = await db.session.create({ data: {
            tag: "snapshot-session", accountId: "snapshot-account", encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }),
        }, select: { id: true } });
        const writer = await holdSqliteWriteLock();
        try {
            await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
                await app.listen({ host: "127.0.0.1", port: 0 });
                const headers = {
                    "x-test-user-id": "snapshot-account", "x-happier-account-stored-content-protocol": "4",
                    "content-type": "application/json",
                };
                const responses = await Promise.all([
                    fetch(`${app.listeningOrigin}/v2/sessions?limit=1`, { headers }),
                    fetch(`${app.listeningOrigin}/v2/sessions/${session.id}`, { headers }),
                    fetch(`${app.listeningOrigin}/v2/sessions/query`, { method: "POST", headers,
                        body: JSON.stringify({ v: 1, storage: "active", includeInactive: true,
                            scope: "my_work", attention: "any", audiences: [], tagIds: [], limit: 1 }) }),
                ]);
                expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
                const bodies = await Promise.all(responses.map(response => response.json()));
                expect(bodies[0]).toMatchObject({ sessions: [{ id: session.id }] });
                expect(bodies[1]).toMatchObject({ session: { id: session.id } });
                expect(bodies[2]).toMatchObject({ sessions: [{ id: session.id }] });
            });
        } finally { await writer.release(); }
    });

    it("serves signed Account and Artifact HTTP reads before a blocked primary writer is released", async () => {
        const account = await db.account.create({ data: {
            ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 7, seq: 1,
        } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        await db.accountSettingsSnapshot.create({ data: {
            accountId: account.id, version: 7, encryptionMode: "e2ee", contentKind: "encrypted", settingsDbValue: "history-ciphertext",
        } });
        const profileId = "snapshot-profile";
        const profileCiphertext = sealAccountScopedBlobCiphertext({ kind: "account_profile_record",
            material: { type: "legacy", secret: tweetnacl.randomBytes(32) }, payload: { id: profileId }, randomBytes: tweetnacl.randomBytes });
        await db.userKVStore.create({ data: { accountId: account.id, key: buildProfilePhysicalKey(profileId), version: 1,
            value: Buffer.from(JSON.stringify({ t: "encrypted", c: profileCiphertext })),
        } });
        const artifact = await db.artifact.create({ data: {
            id: "44444444-4444-4444-8444-444444444444", accountId: account.id, header: Buffer.from("header"), headerVersion: 1,
            body: Buffer.from("body"), bodyVersion: 1, dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({
                dataKey: tweetnacl.randomBytes(32), recipientPublicKey: account.contentPublicKey!,
                randomBytes: tweetnacl.randomBytes,
            }), seq: 1,
        } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: "signed-read-snapshot", metadata: "encrypted-metadata", encryptionMode: "e2ee",
        } });
        expect((await recordLegacyUsageReport({ accountId: account.id, sessionId: session.id, key: "snapshot-usage",
            tokens: { total: 5, input: 2, output: 3 }, cost: { total: 0 },
        })).ok).toBe(true);
        await db.accountChange.create({ data: {
            accountId: account.id, cursor: 1, kind: "session", entityId: session.id, sessionId: session.id,
            hint: { pendingCount: 0, pendingVersion: 1 },
        } });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        accountRoutes(app);
        artifactsRoutes(app);
        changesRoutes(app);
        await app.ready();
        const successfulUrls = ["/v1/account/settings", "/v2/account/settings", "/v1/account/encryption",
            "/v1/account/encryption/currentness", "/v1/artifacts?limit=1", `/v1/artifacts/${artifact.id}`,
            `/v1/artifacts/${artifact.id}/access/grants`, `/v1/artifacts/${artifact.id}/access/recipients`,
            `/v1/artifacts/${artifact.id}/revisions`, "/v1/artifacts/storage/usage", "/v1/account/encryption/artifacts",
            "/v2/cursor", "/v2/changes?limit=1", `/v2/changes?sessionAccessSessionId=${session.id}`,
            "/v2/account/settings/history", "/v2/account/settings/history/7", PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
            "/v1/account/profile", "/v1/account/activity/badge-snapshot", "/v1/account/usage/prices", PROFILE_TRANSFER_ROUTE_V1,
            "/v1/account/plugin-settings/example.tasks", "/v1/account/plugin-storage/example.tasks",
            "/v1/account/authoring-memory", "/v1/account/authoring-memory/lastUsedProfile",
            "/v1/account/entity-rows/acp", "/v1/account/entity-rows/mcp", "/v1/account/entity-rows/provider-connections",
            "/v1/account/entity-rows/remote-hosts", "/v1/account/entity-rows/notification-channels",
            "/v1/account/entity-rows/connected-metadata/presentation", "/v1/account/entity-rows/connected-metadata/acknowledgements",
            "/v1/account/entity-rows/prompt-library", "/v1/account/entity-rows/prompt-library/coding",
            "/v1/account/entity-rows/connected-accounts/configurations",
            homeDomainActionPathForMethod("secrets.shared.list", "GET"),
            "/v1/account/saved-secrets/resources/materials",
            "/v1/account/encryption/migrate/review-comments/inventory",
            "/v1/account/encryption/migrate/session-organization/inventory"];
        const blobUrl = `/v1/artifacts/${artifact.id}/blobs/55555555-5555-4555-8555-555555555555`;
        const censusUrl = "/v1/account/saved-secrets/resources/envelope-census?resourceId=missing-resource";
        const expected = [...successfulUrls.map(url => ({ url, status: 200 })), { url: blobUrl, status: 404 },
            { url: censusUrl, status: 404 },
            { url: "/v1/usage/query", status: 200 }, { url: "/v2/usage/query", status: 200 },
            { url: PROFILE_RECORD_READ_ROUTE_V1, status: 200 }];
        const urls = expected.map(({ url }) => url);
        const headers = { authorization: `Bearer ${token}`,
            "x-happier-account-stored-content-protocol": String(ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION) };
        // Establish valid real auth/route fixtures and a warm cryptographic cache before contention.
        const postReads = new Map<string, Record<string, unknown>>([
            [PROFILE_RECORD_READ_ROUTE_V1, { id: profileId }],
            ["/v1/usage/query", { sessionId: session.id }],
            ["/v2/usage/query", { granularity: "day", includeMessageStats: true, includeInsights: true, filters: { sessionIds: [session.id] } }],
        ]);
        const injectRead = (url: string) => postReads.has(url)
            ? app.inject({ method: "POST", url, headers, payload: postReads.get(url) })
            : app.inject({ method: "GET", url, headers });
        const warm = [];
        for (const url of urls) warm.push(await injectRead(url));
        expect(warm.map((response, index) => ({ url: urls[index], status: response.statusCode })))
            .toEqual(expected);
        // Automation migration inventory deliberately acquires the Account transition fence.
        // It is a currentness-sensitive writer, not a pure snapshot read.
        expect((await app.inject({ method: "GET", url: "/v1/account/encryption/migrate/automations/inventory", headers })).statusCode).toBe(200);
        const writer = await holdSqliteWriteLock();
        let writeSettled = false;
        const blockedWrite = inTx(tx => tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } }))
            .then(() => null, (error: unknown) => error)
            .finally(() => { writeSettled = true; });
        const responses = new Map<string, { statusCode: number; json: () => unknown }>();
        let requests: Promise<unknown>[] = [];
        try {
            await inTx(tx => tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { id: true } }),
                { readOnly: true });
            requests = urls.map(async url => {
                const response = await injectRead(url);
                responses.set(url, response);
            });
            // Test-only observation window, not a product deadline: reads must finish while the lock is held.
            await vi.waitFor(() => {
                expect(urls.map(url => ({ url, status: responses.get(url)?.statusCode })))
                    .toEqual(expected);
            }, { timeout: 1_000 });
            expect(writeSettled).toBe(false);
            expect(responses.get("/v2/account/settings")!.json()).toEqual({ content: { t: "encrypted", c: "ciphertext" }, version: 7 });
            expect(responses.get("/v2/account/settings/history")!.json()).toMatchObject({
                snapshots: [{ version: 7, contentKind: "encrypted", byteLength: Buffer.byteLength("history-ciphertext") }],
            });
            expect(responses.get("/v2/account/settings/history/7")!.json()).toMatchObject({
                version: 7, content: { t: "encrypted", c: "history-ciphertext" },
            });
            expect(responses.get(PROFILE_ROWS_ROUTE_V1)!.json()).toMatchObject({ status: "listed", complete: true,
                referenceGuardRevision: "absent", rows: [{ id: profileId, revision: 1, content: { t: "encrypted", c: profileCiphertext } }],
            });
            expect(responses.get(PROFILE_REFERENCE_GUARD_ROUTE_V1)!.json()).toEqual({ status: "ready", revision: "absent" });
            expect(responses.get(PROFILE_RECORD_READ_ROUTE_V1)!.json()).toEqual({ status: "present", revision: 1,
                content: { t: "encrypted", c: profileCiphertext },
            });
            expect(responses.get("/v1/usage/query")!.json()).toMatchObject({ totalReports: 1, usage: [{ tokens: { total: 5 } }] });
            expect(responses.get("/v2/usage/query")!.json()).toMatchObject({ v: 1, totals: { eventCount: 1, tokens: { total: 5 } },
                messageStats: { sessionCount: 1, messageCount: 0 },
            });
            expect(responses.get("/v1/account/usage/prices")!.json()).toMatchObject({ provenance: { origin: "bundled" } });
            expect(responses.get("/v1/artifacts?limit=1")!.json()).toMatchObject([{ id: artifact.id }]);
            expect(responses.get("/v2/changes?limit=1")!.json()).toMatchObject({
                nextCursor: 1, changes: [{ entityId: session.id, hint: { pendingExecutionRunIds: [] } }],
                sessionAccessWitness: { entries: [{ sessionId: session.id, status: "available" }] },
            });
        } finally {
            await writer.release();
            await blockedWrite;
            await Promise.all(requests);
            await app.close();
        }
        // A snapshot must not turn the warm crypto cache into stale authorization.
        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(auth.verifyToken(token)).resolves.toBeNull();
    });

    it("drains an active read on shutdown and creates a fresh read connection after initialization", async () => {
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const read = inTx(async tx => {
            entered();
            await gate;
            return await tx.account.findUniqueOrThrow({ where: { id: "snapshot-account" }, select: { seq: true } });
        }, { readOnly: true });
        await started;
        const shutdown = shutdownDbClient();
        release();
        await expect(read).resolves.toEqual({ seq: 4 });
        await shutdown;
        await initDbSqlite();
        await expect(inTx(tx => tx.account.findUniqueOrThrow({ where: { id: "snapshot-account" }, select: { seq: true } }),
            { readOnly: true })).resolves.toEqual({ seq: 4 });
    });
});
