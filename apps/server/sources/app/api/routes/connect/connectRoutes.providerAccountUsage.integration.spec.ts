import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import {
    closeProviderAccountUsageTrackedApps,
    createProviderAccountUsageRecordKey,
    createProviderAccountUsageTestApp,
    createUsageSnapshot,
    createV3ProviderAccountUsagePayload,
} from "./providerAccountUsageTestkit";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { writeProviderAccountUsageRecord } from "./providerAccountUsage";

describe("connectRoutes (provider account usage canonical routes)", () => {
    let harness: LightSqliteHarness;
    const connections: ClientConnection[] = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        for (const connection of connections.splice(0)) eventRouter.removeConnection(connection.userId, connection);
        await closeProviderAccountUsageTrackedApps();
        harness.resetEnv();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("lists pending refresh requests only for the authenticated account and clears fulfilled requests", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional", HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain" });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const other = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() - 10_000 });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as Parameters<typeof connectRoutes>[0]);
        await app.ready();
        // Socket.IO emission is the transport boundary; exercise the real account recipient filter.
        const ownEmit = vi.fn();
        const otherEmit = vi.fn();
        for (const [userId, emit] of [[user.id, ownEmit], [other.id, otherEmit]] as const) {
            const connection: ClientConnection = { connectionType: "machine-scoped", userId, machineId: `machine-${userId}`,
                socket: { emit } as unknown as Socket };
            connections.push(connection);
            eventRouter.addConnection(userId, connection);
        }
        const headers = { "x-test-user-id": user.id };
        expect((await app.inject({ method: "POST", url: `/v3/connect/provider-account-usage/${snapshot.recordId}`, headers,
            payload: createV3ProviderAccountUsagePayload({ snapshot }) })).statusCode).toBe(200);
        expect((await app.inject({ method: "POST", url: `/v3/connect/provider-account-usage/${snapshot.recordId}/refresh`, headers })).statusCode).toBe(200);
        expect(ownEmit.mock.calls).toContainEqual(["ephemeral", { type: "provider-account-usage-refresh-requested" }]);
        expect(otherEmit).not.toHaveBeenCalled();
        const list = () => app.inject({ method: "GET", url: "/v2/connect/provider-account-usage/refresh-requests", headers });
        const pending = await list();
        expect(pending.statusCode).toBe(200);
        expect(pending.json()).toEqual({ recordIds: [snapshot.recordId] });
        expect((await app.inject({ method: "GET", url: "/v2/connect/provider-account-usage/refresh-requests", headers: { "x-test-user-id": other.id } })).json()).toEqual({ recordIds: [] });
        const fresh = createUsageSnapshot({ fetchedAt: Date.now() + 1 });
        expect((await app.inject({ method: "POST", url: `/v3/connect/provider-account-usage/${snapshot.recordId}`, headers,
            payload: createV3ProviderAccountUsagePayload({ snapshot: fresh }) })).statusCode).toBe(200);
        expect((await list()).json()).toEqual({ recordIds: [] });
    });

    it("stores and returns a plaintext provider-account usage envelope for plaintext accounts", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "team" });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot, fingerprint: "usage:v3:1" }),
        });
        expect(write.statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            content: { t: "plain", v: expect.objectContaining({ recordId: snapshot.recordId, planLabel: "team" }) },
            metadata: {
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
            sources: [],
        });

        const row = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { payloadMode: true, metadata: true },
        });
        expect(row).toMatchObject({
            payloadMode: "plain_json_v1",
            metadata: { materialFingerprint: "usage:v3:1" },
        });
    });

    it("records refresh failures without refreshing meters or clearing later requests", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: 1000, planLabel: "old" });
        await db.serviceAccountToken.create({ data: {
            accountId: user.id, vendor: "openai-codex", profileId: "work", token: Buffer.from("quota-refresh-test"),
            metadata: { kind: "oauth", providerAccountId: snapshot.recordKey.accountSubjectId },
        } });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as Parameters<typeof connectRoutes>[0]);
        await app.ready();
        const write = async (value: typeof snapshot, refreshErrorAt?: number) => {
            const payload = createV3ProviderAccountUsagePayload({ snapshot: value, fingerprint: `usage:${value.planLabel}:${value.state}` });
            return await app.inject({
                method: "POST", url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: { ...payload, metadata: { ...payload.metadata, status: refreshErrorAt === undefined ? "ok" : "error" },
                    source: { serviceId: "openai-codex", profileId: "work", bindingKind: "profile" } },
            });
        };
        const read = async () => (await app.inject({
            method: "GET", url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        })).json();
        expect((await write(snapshot)).statusCode).toBe(200);
        const failure = { ...snapshot, state: "error_last_known_good" as const,
            diagnostics: [{ kind: "provider_http" as const, status: 429, observedAtMs: 3000 }] };
        await db.providerAccountUsageRecord.updateMany({ where: { accountId: user.id }, data: { refreshRequestedAt: new Date(2000) } });
        expect((await write(failure, 3000)).statusCode).toBe(200);
        expect(await read()).toMatchObject({ content: { v: { fetchedAtMs: 1000, state: "error_last_known_good" } }, metadata: { fetchedAt: 1000, status: "error", refreshErrorAt: 3000 } });
        expect((await read()).metadata).not.toHaveProperty("refreshRequestedAt");
        const quotaRead = await app.inject({ method: "GET", url: "/v3/connect/openai-codex/profiles/work/quotas", headers: { "x-test-user-id": user.id } });
        expect(quotaRead.statusCode).toBe(200);
        expect(quotaRead.json()).toMatchObject({
            metadata: { fetchedAt: 1000, status: "error", refreshErrorAt: 3000 },
            content: { v: { fetchedAt: 1000, evidence: { status: 429, observedAtMs: 3000 } } },
        });
        // A concurrent newer success owns the meters; an older observation can only contribute its failure outcome.
        expect((await write(createUsageSnapshot({ fetchedAt: 4000, planLabel: "new" }))).statusCode).toBe(200);
        await db.providerAccountUsageRecord.updateMany({ where: { accountId: user.id }, data: { refreshRequestedAt: new Date(6000) } });
        expect((await write({ ...failure, diagnostics: [{ kind: "provider_http", status: 429, observedAtMs: 5000 }] }, 5000)).statusCode).toBe(200);
        expect(await read()).toMatchObject({ content: { v: { fetchedAtMs: 4000, planLabel: "new" } }, metadata: { fetchedAt: 4000, status: "error", refreshErrorAt: 5000, refreshRequestedAt: 6000 } });
        // Replayed older failures and forged/future metadata cannot settle the pending request.
        expect((await write(failure, 3000)).statusCode).toBe(200);
        expect((await read()).metadata).toMatchObject({ refreshErrorAt: 5000, refreshRequestedAt: 6000 });
        const future = Date.now() + 60000;
        expect((await write({ ...failure, diagnostics: [{ kind: "provider_http", status: 429, observedAtMs: future }] }, future)).statusCode).toBe(400);
    });

    it("accepts sealed refresh outcomes and preserves newer provider observations", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "public-key", encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: 1000 });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as Parameters<typeof connectRoutes>[0]);
        await app.ready();
        const write = (fetchedAt: number, ciphertext: string, refreshErrorAt?: number) => app.inject({
            method: "POST", url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { recordKey: snapshot.recordKey, sealed: { format: "account_scoped_v1", ciphertext },
                metadata: { fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: refreshErrorAt === undefined ? "ok" : "error", ...(refreshErrorAt === undefined ? {} : { refreshErrorAt }) } },
        });
        const read = async () => (await app.inject({ method: "GET", url: `/v2/connect/provider-account-usage/${snapshot.recordId}`, headers: { "x-test-user-id": user.id } })).json();
        // A first failure with no last-known-good observation still has a durable outcome.
        expect((await write(0, "first-failure", 2000)).statusCode).toBe(200);
        expect(await read()).toMatchObject({ metadata: { fetchedAt: 0, status: "error", refreshErrorAt: 2000 } });
        expect((await write(3000, "fresh")).statusCode).toBe(200);
        await db.providerAccountUsageRecord.updateMany({ where: { accountId: user.id }, data: { refreshRequestedAt: new Date(4000) } });
        expect((await write(3000, "same-observation-error", 5000)).statusCode).toBe(200);
        expect(await read()).toMatchObject({ sealed: { ciphertext: "same-observation-error" }, metadata: { fetchedAt: 3000, status: "error", refreshErrorAt: 5000 } });
        expect((await read()).metadata).not.toHaveProperty("refreshRequestedAt");
        expect((await write(6000, "newest")).statusCode).toBe(200);
        expect((await write(1000, "older-error", 7000)).statusCode).toBe(200);
        expect(await read()).toMatchObject({ sealed: { ciphertext: "newest" }, metadata: { fetchedAt: 6000, status: "error", refreshErrorAt: 7000 } });
    });

    it("preserves independently fresh subscription observations without changing the legacy snapshot envelope", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: 1000 });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as Parameters<typeof connectRoutes>[0]);
        await app.ready();
        const subscription = {
            status: "subscribed", renewal: "off", observedAtMs: 2000, staleAfterMs: 60000,
            currentPeriodEndAtMs: 100000,
        };
        const write = async (fetchedAt: number, observation?: typeof subscription | { status: string; renewal: string; observedAtMs: number; staleAfterMs: number }) => {
            const payload = createV3ProviderAccountUsagePayload({ snapshot: createUsageSnapshot({ fetchedAt }) });
            return await app.inject({
                method: "POST", url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: { ...payload, metadata: { ...payload.metadata, ...(observation ? { subscription: observation } : {}) } },
            });
        };
        expect((await write(1000, subscription)).statusCode).toBe(200);
        expect((await write(3000)).statusCode).toBe(200);
        const read = async () => (await app.inject({
            method: "GET", url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id, accept: "application/json; happier-account-subscription=1" },
        })).json();
        expect(await read()).toMatchObject({ subscription, content: { v: { fetchedAtMs: 3000 } } });
        expect((await read()).content.v).not.toHaveProperty("subscription");
        const legacyRead = await app.inject({ method: "GET", url: `/v3/connect/provider-account-usage/${snapshot.recordId}`, headers: { "x-test-user-id": user.id } });
        expect(legacyRead.json()).not.toHaveProperty("subscription");
        expect(legacyRead.json().content.v).not.toHaveProperty("subscription");
        const row = await db.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: user.id, recordId: snapshot.recordId } } });
        expect(row.snapshot).not.toHaveProperty("subscription");
        expect(row.metadata).toMatchObject({ subscription });
        // A fresh billing result can arrive with an older quota snapshot.
        const none = { status: "none", renewal: "unknown", observedAtMs: 4000, staleAfterMs: 60000 };
        expect((await write(1000, none)).statusCode).toBe(200);
        expect(await read()).toMatchObject({ subscription: none, content: { v: { fetchedAtMs: 3000 } } });
        expect((await write(5000, subscription)).statusCode).toBe(200);
        expect(await read()).toMatchObject({ subscription: none, content: { v: { fetchedAtMs: 5000 } } });
    });

    it("returns recovery details alongside the ordinary plaintext quota envelope", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const recoveryCredits = {
            kind: "usage_limit_resets", availableCount: 2,
            credits: [{ providerCreditId: "reset_one", kind: "rate_limit_reset", status: "available" }],
        };
        const base = createUsageSnapshot({ fetchedAt: 1000, recoveryCredits });
        const recoveryCreditDetails = { reset_one: { remainingCount: 2, appliesToProviderLimitIds: ["weekly"] } };
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as Parameters<typeof connectRoutes>[0]);
        await app.ready();
        const payload = createV3ProviderAccountUsagePayload({ snapshot: base });
        const write = await app.inject({
            method: "POST", url: `/v3/connect/provider-account-usage/${base.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { ...payload, metadata: { ...payload.metadata, recoveryCreditDetails } },
        });
        expect(write.statusCode).toBe(200);
        const response = await app.inject({
            method: "GET", url: `/v3/connect/provider-account-usage/${base.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            recoveryCreditDetails,
            content: { t: "plain", v: { meters: base.meters, recoveryCredits: base.recoveryCredits } },
        });
        expect(response.json().content.v).not.toHaveProperty("recoveryCreditDetails");
    });

    it("rejects recovery detail authoring when disabled while accepting ordinary plaintext quota writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_BUILD_FEATURES_DENY: "connectedServices.quotaRecoveryCreditDetails",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const base = createUsageSnapshot({ fetchedAt: 1000 });
        const payload = createV3ProviderAccountUsagePayload({ snapshot: base });
        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as Parameters<typeof connectRoutes>[0]);
        await app.ready();
        const write = (body: typeof payload | { content: typeof payload.content; metadata: typeof payload.metadata & { recoveryCreditDetails: object } }) => app.inject({
            method: "POST", url: `/v3/connect/provider-account-usage/${base.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id }, payload: body,
        });
        const rejected = await write({ ...payload, metadata: { ...payload.metadata, recoveryCreditDetails: { reset_one: { remainingCount: 2 } } } });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toMatchObject({ error: "invalid-params", reason: "provider_account_usage_payload_invalid" });
        const inlineRejected = await write({
            ...payload,
            content: { t: "plain", v: { ...base, recoveryCreditDetails: { reset_one: { remainingCount: 2, appliesToProviderLimitIds: [] } } } },
        });
        expect(inlineRejected.statusCode).toBe(400);
        expect(inlineRejected.json()).toMatchObject({ error: "invalid-params", reason: "provider_account_usage_payload_invalid" });
        expect((await write(payload)).statusCode).toBe(200);
    });

    it("does not create plaintext provider-account usage rows from refresh requests for missing records", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}/refresh`,
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(404);
        expect(refresh.json()).toEqual({ error: "provider_account_usage_not_found" });
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects stale plaintext writes without a fingerprint from overwriting newer stored material", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const fetchedAt = Date.now();
        const newerSnapshot = createUsageSnapshot({ fetchedAt, planLabel: "newer-plan" });
        const staleSnapshot = createUsageSnapshot({
            fetchedAt: fetchedAt - 1,
            planLabel: "stale-plan",
            recordKey: newerSnapshot.recordKey,
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: newerSnapshot }),
        })).statusCode).toBe(200);

        expect((await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: staleSnapshot }),
        })).statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v3/connect/provider-account-usage/${newerSnapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            content: { t: "plain", v: expect.objectContaining({ planLabel: "newer-plan", fetchedAtMs: fetchedAt }) },
            metadata: {
                fetchedAt,
                staleAfterMs: 60_000,
                status: "ok",
            },
            sources: [],
        });
    });

    it("returns 409 for sealed provider-account usage writes that lack an existing trusted record key", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "public-key", encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                    materialFingerprint: "usage:v2:blocked",
                },
            },
        });
        expect(write.statusCode).toBe(409);
        expect(write.json()).toEqual({ error: "provider_account_usage_record_key_required" });
    });

    it("returns a 400 instead of a response serialization error for malformed sealed usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "public-key", encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: { format: "account_scoped_v1", ciphertext: "" },
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });

        expect(write.statusCode).toBe(400);
    });

    it("reads, refreshes, and deletes sealed provider-account usage when a trusted record already exists", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "e2ee",
        });
        const user = await db.account.create({ data: { publicKey: "public-key", encryptionMode: "e2ee" }, select: { id: true } });
        const recordKey = createProviderAccountUsageRecordKey();
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey,
            payloadMode: "sealed_account_scoped_v1",
            status: "ok",
            sealedPayload: { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage" },
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const recoveryCreditDetails = { ciphertext: "opaque-recovery-details" };
        const updatedSealed = { format: "account_scoped_v1", ciphertext: "sealed-provider-account-usage", recoveryCreditDetails };
        const write = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                sealed: updatedSealed,
                metadata: { fetchedAt: snapshot.fetchedAtMs + 1, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(write.statusCode).toBe(200);

        const read = await app.inject({
            method: "GET",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({
            sealed: updatedSealed,
            metadata: {
                fetchedAt: snapshot.fetchedAtMs + 1,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
            sources: [],
        });
        const persisted = await db.providerAccountUsageRecord.findUniqueOrThrow({
            where: { accountId_recordId: { accountId: user.id, recordId: snapshot.recordId } },
        });
        expect(persisted.snapshot ?? {}).toEqual({});
        expect(persisted.metadata ?? {}).not.toHaveProperty("recoveryCreditDetails");
        expect(persisted.sealedPayload).toEqual(updatedSealed);

        const refresh = await app.inject({
            method: "POST",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}/refresh`,
            headers: { "x-test-user-id": user.id },
        });
        expect(refresh.statusCode).toBe(200);

        const refreshed = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { refreshRequestedAt: true },
        });
        expect(refreshed?.refreshRequestedAt).not.toBeNull();

        const deleted = await app.inject({
            method: "DELETE",
            url: `/v2/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "x-test-user-id": user.id },
        });
        expect(deleted.statusCode).toBe(200);
        expect(await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: snapshot.recordId,
                },
            },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects canonical usage diagnostics with token-like headers", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const validSnapshot = createUsageSnapshot({ fetchedAt: Date.now() });
        const snapshot = {
            ...validSnapshot,
            diagnostics: [{ kind: "provider_http", headers: { authorization: "Bearer token" } }],
        };

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const write = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${validSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot: snapshot as ReturnType<typeof createUsageSnapshot> }),
        });
        expect(write.statusCode).toBe(400);
        expect(write.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_payload_invalid",
        });
    });

    it("returns safe machine-readable reasons for invalid plaintext provider-account usage writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });
        const otherSnapshot = createUsageSnapshot({
            fetchedAt: Date.now() + 1,
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "other-account" }),
        });

        const app = createProviderAccountUsageTestApp();
        connectRoutes(app as any);
        await app.ready();

        const wrongRecordId = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${otherSnapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: createV3ProviderAccountUsagePayload({ snapshot }),
        });
        expect(wrongRecordId.statusCode).toBe(400);
        expect(wrongRecordId.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_record_id_mismatch",
        });

        const mismatchedClock = await app.inject({
            method: "POST",
            url: `/v3/connect/provider-account-usage/${snapshot.recordId}`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...createV3ProviderAccountUsagePayload({ snapshot }),
                metadata: {
                    fetchedAt: snapshot.fetchedAtMs + 1,
                    staleAfterMs: snapshot.staleAfterMs,
                    status: "ok",
                },
            },
        });
        expect(mismatchedClock.statusCode).toBe(400);
        expect(mismatchedClock.json()).toEqual({
            error: "invalid-params",
            reason: "provider_account_usage_payload_invalid",
        });
    });
});
