import { createHash, randomBytes } from "node:crypto";
import {
    CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS,
    createConnectedAccountAttemptTransactionAdapters,
    createConnectedAccountAttemptTransactionApi,
    generatePkceCodes,
    type ConnectedAccountDeviceTransactionSnapshot,
    type ConnectedAccountOAuthTransactionSnapshot,
} from "@happier-dev/cli-common/connectedAccounts";
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from "@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import {
    registerConnectedAccountAttemptTransactionRoutes,
} from "./connectedAccountAttemptTransactions/registerConnectedAccountAttemptTransactionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();
const oauthScope = {
    machineId: "machine-a",
    service: { pluginId: "acme.accounts", localId: "work" },
    modeId: "oauth",
    intent: "connect",
    phase: "awaitingOAuth",
    createdAtMs: 1,
} as const;
const deviceScope = {
    ...oauthScope,
    modeId: "device",
    phase: "awaitingDeviceAuthorization",
} as const;

function transactionReadUrl(mutationUrl: string): string {
    return mutationUrl.replace(/\/(?:oauth|device)\//u, "/");
}

async function createE2eeAccount(): Promise<Readonly<{ id: string }>> {
    return await db.account.create({
        data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
        select: { id: true },
    });
}

async function createPlainAccount(): Promise<Readonly<{ id: string }>> {
    return await db.account.create({
        data: { publicKey: null, encryptionMode: "plain" },
        select: { id: true },
    });
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
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

function createHttpApi(app: ReturnType<typeof createTestApp>, accountId: string) {
    return createConnectedAccountAttemptTransactionApi({
        token: "test-account-token", baseUrl: "https://test.example",
        headers: { "x-test-user-id": accountId },
        http: { async request(input) {
            const url = new URL(input.url);
            const response = await app.inject({
                method: input.method ?? "GET", url: `${url.pathname}${url.search}`,
                headers: { ...input.headers },
                ...(input.body === undefined ? {} : { payload: new TextDecoder().decode(input.body) }),
            });
            return { status: response.statusCode, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(response.body) };
        } },
    });
}

describe("Connected Account attempt transaction routes", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-connected-account-attempt-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.repeatKey.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    it.each(["plain", "e2ee"] as const)("uses the portable durable owner through real HTTP/CAS above half-MiB with a %s Account", async accountMode => {
        const account = accountMode === "plain" ? await createPlainAccount() : await createE2eeAccount();
        const app = createTestApp();
        await app.ready();
        const material = { type: "dataKey" as const, machineKey: new Uint8Array(32).fill(13) };
        const api = createHttpApi(app, account.id);
        const createOwner = () => createConnectedAccountAttemptTransactionAdapters({
            api, randomBytes,
            generatePkceCodes: () => generatePkceCodes({ randomBytes, sha256: value => new Uint8Array(createHash("sha256").update(value).digest()) }),
            async seal(payload) {
                return accountMode === "plain"
                    ? sealQualifiedConnectedAccountContentEnvelope({ kind: "attempt", accountMode, payload, randomBytes })
                    : sealQualifiedConnectedAccountContentEnvelope({ kind: "attempt", accountMode, material, payload, randomBytes });
            },
            async open(record) {
                return accountMode === "plain"
                    ? openQualifiedConnectedAccountContentEnvelope({ kind: "attempt", accountMode, envelope: record.content })
                    : openQualifiedConnectedAccountContentEnvelope({ kind: "attempt", accountMode, material, envelope: record.content });
            },
        });
        const owner = createOwner();
        const snapshot: ConnectedAccountOAuthTransactionSnapshot = {
            attemptId: "portable-attempt", createdAtMs: Date.now(), intent: "connect", service: oauthScope.service,
            modeId: "oauth", sourceCustody: { kind: "managed", immutableGenerationId: "artifact-sha256", installSource: "npm" },
            expectedCredentialRevision: null, expectedCredentialConfigurationRevision: null,
            expectedConfigurationRevision: "configuration-1", phase: "starting", stagedCredentials: {},
            stagedAccountConfigurationContent: { configuration: "x".repeat(524_288 + 1) },
            expiresAtMs: Date.now() + 60_000,
        };
        await owner.address.acknowledge({ attemptId: snapshot.attemptId, kind: "oauth", phase: "configurationRequired",
            createdAtMs: snapshot.createdAtMs, intent: snapshot.intent, service: snapshot.service, modeId: snapshot.modeId });
        const started = await owner.oauth.create({ attemptId: snapshot.attemptId, service: snapshot.service, snapshot, callbackUrl: "https://app.example/callback" });
        await started.acknowledge({ ...snapshot, phase: "awaitingOAuth" });
        const first = await owner.oauth.read(snapshot.attemptId);
        const second = await owner.oauth.read(snapshot.attemptId);
        expect(first?.request).toEqual(started.request);
        expect(first?.snapshot.stagedAccountConfigurationContent).toEqual(snapshot.stagedAccountConfigurationContent);
        const completion = { code: "returned-code", state: started.request.state, callbackUrl: started.request.callbackUrl };
        await expect(first!.acceptCompletion({ ...completion, state: "foreign-state" })).rejects.toThrow();
        const settled = await Promise.allSettled([first!.acceptCompletion(completion), second!.acceptCompletion(completion)]);
        const accepted = settled.filter(result => result.status === "fulfilled");
        expect(accepted).toHaveLength(1);
        expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
        const challenge = createHash("sha256").update(accepted[0]!.value.pkceVerifier).digest("base64url");
        expect(challenge).toBe(started.request.pkce.challenge);
        const restored = await owner.oauth.read(snapshot.attemptId);
        await expect(restored!.acceptCompletion(completion)).rejects.toThrow();

        const preparedSettlement = {
            intent: snapshot.intent, service: snapshot.service, accountId: "connected-account",
            authenticationModeId: snapshot.modeId, directExportContract: null,
            expectedCredentialRevision: snapshot.expectedCredentialRevision,
            expectedCredentialConfigurationRevision: snapshot.expectedCredentialConfigurationRevision,
            expectedConfigurationRevision: snapshot.expectedConfigurationRevision,
            sourceCustody: snapshot.sourceCustody,
            stagedCredentials: { accessToken: "prepared-token-sentinel" },
            displayName: "Connected account", scopes: [],
        } as const;
        const winner = [first, second][settled.findIndex(result => result.status === "fulfilled")]!;
        await winner.acknowledge({ ...snapshot, phase: "outcomeUnknown", preparedSettlement });
        const { phase: _phase, ...deviceBase } = snapshot;
        const deviceSnapshot: ConnectedAccountDeviceTransactionSnapshot = {
            ...deviceBase, attemptId: "portable-device-attempt", modeId: "device",
            expiresAtMs: snapshot.expiresAtMs!, pollIntervalMs: 5_000,
            nextPollAtMs: Date.now(), verificationUri: "https://provider.example/device", userCode: "device-code",
        };
        const preparedDevice = { ...deviceSnapshot, preparedSettlement: { ...preparedSettlement, authenticationModeId: "device" } };
        await owner.address.acknowledge({ attemptId: deviceSnapshot.attemptId, kind: "device", phase: "configurationRequired",
            createdAtMs: deviceSnapshot.createdAtMs, intent: deviceSnapshot.intent, service: deviceSnapshot.service, modeId: deviceSnapshot.modeId });
        await owner.device.acknowledge(deviceSnapshot);
        await owner.device.acknowledge(preparedDevice);
        const afterRestart = createOwner();
        const clock = vi.spyOn(Date, "now").mockReturnValue(snapshot.expiresAtMs! - 1);
        try {
            const withinLifetime = await afterRestart.oauth.read(snapshot.attemptId);
            expect(withinLifetime?.snapshot.preparedSettlement).toEqual(preparedSettlement);
            expect(await afterRestart.device.read(deviceSnapshot.attemptId)).toEqual(preparedDevice);
            clock.mockReturnValue(snapshot.expiresAtMs! + 1);
            expect(await afterRestart.oauth.read(snapshot.attemptId)).toBeNull();
            expect(await afterRestart.device.read(deviceSnapshot.attemptId)).toBeNull();
        } finally { clock.mockRestore(); }
    });

    it("reads one authenticated Account attempt by attemptId without knowing its kind", async () => {
        const [account, other] = await Promise.all([createPlainAccount(), createPlainAccount()]);
        const app = createTestApp();
        await app.ready();
        const attemptId = "opaque-addressed-attempt";
        const content = { t: "plain", v: null } as const;
        const expiresAtMs = Date.now() + 60_000;
        const created = await app.inject({
            method: "POST", url: `/v2/connect/connected-account-attempt-transactions/device/${attemptId}`,
            headers: { "x-test-user-id": account.id }, payload: { content, expiresAtMs, scope: deviceScope },
        });
        expect(created.statusCode, created.body).toBe(200);
        let transactionReads = 0;
        const stop = observeSqliteRequests({ before: request => {
            if (request.model === "RepeatKey" && request.action.startsWith("find")) transactionReads++;
        } });
        const read = await (async () => {
            try {
                return await app.inject({ method: "GET", url: `/v2/connect/connected-account-attempt-transactions/${attemptId}`,
                    headers: { "x-test-user-id": account.id } });
            } finally { stop(); }
        })();
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toMatchObject({ kind: "device", scope: deviceScope });
        expect(transactionReads).toBe(1);
        const foreign = await app.inject({ method: "GET", url: `/v2/connect/connected-account-attempt-transactions/${attemptId}`,
            headers: { "x-test-user-id": other.id } });
        expect(foreign.statusCode).toBe(404);
    });

    it("uses the existing server lifetime for an address when the client clock is ahead", async () => {
        const account = await createPlainAccount();
        const app = createTestApp();
        await app.ready();
        const owner = createConnectedAccountAttemptTransactionAdapters({
            api: createHttpApi(app, account.id), randomBytes,
            now: () => Date.now() + 5_000,
            generatePkceCodes: () => generatePkceCodes({ randomBytes, sha256: value => new Uint8Array(createHash("sha256").update(value).digest()) }),
            async seal(payload) {
                return sealQualifiedConnectedAccountContentEnvelope({ kind: "attempt", accountMode: "plain", payload, randomBytes });
            },
            async open(record) {
                return openQualifiedConnectedAccountContentEnvelope({ kind: "attempt", accountMode: "plain", envelope: record.content });
            },
        });
        const serverBefore = Date.now();
        const acknowledged = await owner.address.acknowledge({ attemptId: "client-clock-address", kind: "manual", phase: "awaitingManual",
            createdAtMs: Date.now() + 5_000, intent: "connect", service: oauthScope.service, modeId: "manual" });
        const serverAfter = Date.now();
        expect(acknowledged.expiresAtMs).toBeGreaterThanOrEqual(serverBefore + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS);
        expect(acknowledged.expiresAtMs).toBeLessThanOrEqual(serverAfter + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS);
        expect((await owner.address.read("client-clock-address"))?.expiresAtMs).toBe(acknowledged.expiresAtMs);
    });

    it("leaves earlier short-lived attempt rows untouched and asks the caller to start again", async () => {
        const account = await createPlainAccount();
        const app = createTestApp();
        await app.ready();
        const attemptId = "upgrade-in-flight";
        const headers = { "x-test-user-id": account.id };
        const created = await app.inject({ method: "POST", url: `/v2/connect/connected-account-attempt-transactions/oauth/${attemptId}`,
            headers, payload: { content: { t: "plain", v: null }, scope: oauthScope, expiresAtMs: Date.now() + 60_000 } });
        expect(created.statusCode, created.body).toBe(200);
        const readUrl = `/v2/connect/connected-account-attempt-transactions/${attemptId}`;
        expect((await app.inject({ method: "GET", url: readUrl, headers })).statusCode).toBe(200);
        const row = await db.repeatKey.findFirstOrThrow();
        const accountDigest = createHash("sha256").update(JSON.stringify(["connected-account-attempt-account-v2", account.id])).digest("base64url");
        const oldKey = `caat_v2_${accountDigest}_${createHash("sha256").update(JSON.stringify(["connected-account-attempt-transaction-v2", "oauth", attemptId])).digest("base64url")}`;
        await db.repeatKey.update({ where: { key: row.key }, data: { key: oldKey } });
        const missing = await app.inject({ method: "GET", url: readUrl, headers });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: "connected_account_attempt_transaction_not_found" });
        const pending = await app.inject({ method: "GET", headers,
            url: "/v2/connect/connected-account-attempt-transactions/pending?machineId=machine-a&pluginId=acme.accounts&localId=work" });
        expect(pending.json()).toEqual({ attempts: [] });
        expect(await db.repeatKey.findUnique({ where: { key: oldKey } })).toEqual({ ...row, key: oldKey });
    });

    it.each([
        { kind: "manual", modeId: "manual", phase: "awaitingManual" },
        { kind: "oauth", modeId: "oauth", phase: "configurationRequired" },
    ] as const)("retains the $phase host address within its existing lifetime and then asks to start again", async ({ kind, modeId, phase }) => {
        const account = await createPlainAccount();
        const app = createTestApp();
        await app.ready();
        const attemptId = "native-manual-or-configuration-attempt";
        const scope = { ...oauthScope, modeId, phase };
        const expiresAtMs = Date.now() + 60_000;
        const created = await app.inject({
            method: "POST", url: `/v2/connect/connected-account-attempt-transactions/${kind}/${attemptId}`,
            headers: { "x-test-user-id": account.id },
            payload: { content: { t: "plain", v: null }, expiresAtMs, scope },
        });
        expect(created.statusCode, created.body).toBe(200);
        const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAtMs - 1);
        try {
            const read = await app.inject({ method: "GET", url: `/v2/connect/connected-account-attempt-transactions/${attemptId}`,
                headers: { "x-test-user-id": account.id } });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ kind, expiresAtMs, scope });
            expect(await db.repeatKey.count()).toBe(1);
            const api = createHttpApi(app, account.id);
            expect(await api.read({ attemptId })).toMatchObject({ kind, expiresAtMs, scope });
            expect(await api.listPending({ machineId: scope.machineId, service: scope.service }))
                .toEqual([expect.objectContaining({ attemptId, kind, phase, expiresAtMs })]);
            clock.mockReturnValue(expiresAtMs + 1);
            const expired = await app.inject({ method: "GET", url: `/v2/connect/connected-account-attempt-transactions/${attemptId}`,
                headers: { "x-test-user-id": account.id } });
            expect(expired.statusCode).toBe(404);
            expect(expired.json()).toEqual({ error: "connected_account_attempt_transaction_not_found" });
        } finally { clock.mockRestore(); }
    });

    it("restores Account attempts without a Machine and projects the stored routing scope from the addressed read", async () => {
        const [owner, other] = await Promise.all([createPlainAccount(), createPlainAccount()]);
        const app = createTestApp();
        await app.ready();
        const { machineId: _machineId, ...accountScope } = oauthScope;
        const expiresAtMs = Date.now() + 60_000;
        const content = { t: "plain", v: { pending: true } } as const;
        for (const [attemptId, scope] of [["account-attempt", accountScope], ["machine-attempt", oauthScope]] as const) {
            const url = `/v2/connect/connected-account-attempt-transactions/oauth/${attemptId}`;
            const headers = { "x-test-user-id": owner.id };
            const created = await app.inject({ method: "POST", url, headers, payload: { content, expiresAtMs, scope } });
            expect(created.statusCode, created.body).toBe(200);
            const read = await app.inject({ method: "GET", url: transactionReadUrl(url), headers });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ revision: 1, content, expiresAtMs, scope });
            const foreign = await app.inject({ method: "GET", url: transactionReadUrl(url), headers: { "x-test-user-id": other.id } });
            expect(foreign.statusCode).toBe(404);
        }
        const pending = await app.inject({
            method: "GET",
            url: "/v2/connect/connected-account-attempt-transactions/pending?pluginId=acme.accounts&localId=work",
            headers: { "x-test-user-id": owner.id },
        });
        expect(pending.statusCode, pending.body).toBe(200);
        expect(pending.json().attempts.map((attempt: { attemptId: string }) => attempt.attemptId)).toEqual(["account-attempt"]);
    });

    it("discovers only resumable attempts for the authenticated account, machine, and service without content", async () => {
        const [accountA, accountB] = await Promise.all([
            createE2eeAccount(),
            createE2eeAccount(),
        ]);
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const scope = {
            machineId: "machine-a",
            service: { pluginId: "acme.accounts", localId: "work" },
            modeId: "oauth",
            intent: "connect",
            phase: "awaitingOAuth",
            createdAtMs: Date.now(),
        } as const;
        const create = async (attemptId: string, overrides: Record<string, unknown> = {}) => {
            const response = await app.inject({
                method: "POST",
                url: `/v2/connect/connected-account-attempt-transactions/oauth/${attemptId}`,
                headers: { "x-test-user-id": accountA.id },
                payload: {
                    content: { t: "encrypted", c: `secret-${attemptId}` },
                    expiresAtMs,
                    scope: { ...scope, ...overrides },
                },
            });
            expect(response.statusCode, response.body).toBe(200);
        };
        await create("matching");
        await create("other-machine", { machineId: "machine-b" });
        await create("other-service", { service: { pluginId: "acme.accounts", localId: "other" } });
        await create("not-resumable", { phase: "starting" });

        const url = "/v2/connect/connected-account-attempt-transactions/pending?machineId=machine-a&pluginId=acme.accounts&localId=work";
        let accountModeReads = 0;
        const stopObserving = observeSqliteRequests({ before: request => {
            if (request.model === "Account" && request.action === "findUnique") accountModeReads++;
        } });
        const discovered = await (async () => {
            try {
                return await app.inject({ method: "GET", url: transactionReadUrl(url), headers: { "x-test-user-id": accountA.id } });
            } finally { stopObserving(); }
        })();
        expect(discovered.statusCode).toBe(200);
        expect(accountModeReads).toBe(1);
        expect(discovered.json()).toEqual({ attempts: [{
            attemptId: "matching",
            kind: "oauth",
            modeId: "oauth",
            intent: "connect",
            phase: "awaitingOAuth",
            createdAtMs: scope.createdAtMs,
            expiresAtMs,
        }] });
        expect(discovered.body).not.toContain("secret-");

        const anotherAccount = await app.inject({
            method: "GET",
            url: transactionReadUrl(url),
            headers: { "x-test-user-id": accountB.id },
        });
        expect(anotherAccount.json()).toEqual({ attempts: [] });
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    });

    it("stores only the opaque E2EE envelope and isolates exact attempts by account", async () => {
        const [accountA, accountB] = await Promise.all([
            createE2eeAccount(),
            createE2eeAccount(),
        ]);
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const ciphertext = "opaque-ciphertext-without-readable-provider-state";
        const content = { t: "encrypted", c: ciphertext } as const;
        const url = "/v2/connect/connected-account-attempt-transactions/oauth/attempt_01HZX4T3Q7";

        const created = await app.inject({
            method: "POST",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": accountA.id,
            },
            payload: { content, expiresAtMs, scope: oauthScope },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toMatchObject({
            revision: 1,
            content,
            expiresAtMs,
            scope: oauthScope,
        });

        const rows = await db.repeatKey.findMany();
        expect(rows).toHaveLength(1);
        const accountDigest = createHash("sha256")
            .update(JSON.stringify(["connected-account-attempt-account-v2", accountA.id]))
            .digest("base64url");
        const canonicalKey = `caat_v3_${accountDigest}_${createHash("sha256")
            .update(JSON.stringify([
                "connected-account-attempt-transaction-v3",
                "attempt_01HZX4T3Q7",
            ]))
            .digest("base64url")}`;
        expect(rows[0]?.key).toBe(canonicalKey);
        expect(rows[0]?.key).not.toContain(accountA.id);
        expect(rows[0]?.key).not.toContain("attempt_01HZX4T3Q7");
        expect(rows[0]?.value).toContain(ciphertext);
        expect(rows[0]?.value).not.toContain("stagedCredentials");
        expect(rows[0]?.value).not.toContain("pkceVerifier");

        const sameAccount = await app.inject({
            method: "GET",
            url: transactionReadUrl(url),
            headers: { "x-test-user-id": accountA.id },
        });
        expect(sameAccount.statusCode).toBe(200);
        expect(sameAccount.json()).toEqual(created.json());

        const crossAccount = await app.inject({
            method: "GET",
            url: transactionReadUrl(url),
            headers: { "x-test-user-id": accountB.id },
        });
        expect(crossAccount.statusCode).toBe(404);
        expect(crossAccount.json()).toEqual({
            error: "connected_account_attempt_transaction_not_found",
        });
    });

    it("replaces and deletes only the exact current revision", async () => {
        const account = await createE2eeAccount();
        const app = createTestApp();
        await app.ready();
        const url = "/v2/connect/connected-account-attempt-transactions/device/device-attempt-1";
        const firstExpiry = Date.now() + 15 * 60_000;
        const secondExpiry = firstExpiry + 1_000;
        await app.inject({
            method: "POST",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                content: { t: "encrypted", c: "opaque-first" },
                expiresAtMs: firstExpiry,
                scope: deviceScope,
            },
        });

        const replaced = await app.inject({
            method: "PATCH",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                expectedRevision: 1,
                content: { t: "encrypted", c: "opaque-second" },
                expiresAtMs: secondExpiry,
                scope: deviceScope,
            },
        });
        expect(replaced.statusCode).toBe(200);
        expect(replaced.json()).toMatchObject({
            revision: 2,
            content: { t: "encrypted", c: "opaque-second" },
            expiresAtMs: secondExpiry,
            scope: deviceScope,
        });

        const staleReplace = await app.inject({
            method: "PATCH",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                expectedRevision: 1,
                content: { t: "encrypted", c: "opaque-stale" },
                expiresAtMs: secondExpiry,
                scope: deviceScope,
            },
        });
        expect(staleReplace.statusCode).toBe(409);
        expect(staleReplace.json()).toEqual({
            error: "connected_account_attempt_transaction_conflict",
        });

        const staleDelete = await app.inject({
            method: "DELETE",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: { expectedRevision: 1 },
        });
        expect(staleDelete.statusCode).toBe(409);

        const deleted = await app.inject({
            method: "DELETE",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: { expectedRevision: 2 },
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ status: "deleted" });
        expect((await app.inject({
            method: "GET",
            url: transactionReadUrl(url),
            headers: { "x-test-user-id": account.id },
        })).statusCode).toBe(404);
    });

    it("rejects traversal and plaintext-bearing bodies", async () => {
        const account = await createE2eeAccount();
        const app = createTestApp();
        await app.ready();
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": account.id,
        };
        const invalidAttempt = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/oauth/%2E%2E%2Fall",
            headers,
            payload: {
                content: { t: "encrypted", c: "opaque" },
                expiresAtMs: Date.now() + 60_000,
            },
        });
        expect(invalidAttempt.statusCode).toBe(400);

        const plaintext = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/oauth/attempt-1",
            headers,
            payload: {
                content: { t: "encrypted", c: "opaque" },
                expiresAtMs: Date.now() + 60_000,
                scope: oauthScope,
                stagedCredentials: { token: "plaintext-secret" },
            },
        });
        expect(plaintext.statusCode).toBe(400);

        expect(await db.repeatKey.count()).toBe(0);
    });

    it("seals a plain Account's readable attempt payload at rest and reopens it", async () => {
        // A plain Account's envelope is the readable value, and an in-flight
        // authentication attempt carries the PKCE verifier and the staged provider
        // secrets. The same Account's settled credentials are sealed with the
        // server at-rest key, so its in-flight ones cannot sit in the database in
        // the clear.
        const account = await createPlainAccount();
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const url =
            "/v2/connect/connected-account-attempt-transactions/oauth/plain-attempt";
        const verifier = "pkce-verifier-must-not-be-readable";
        const stagedSecret = "device-auth-secret-must-not-be-readable";
        const content = {
            t: "plain",
            v: {
                version: 1,
                kind: "oauth",
                verifier,
                stagedCredentials: { deviceAuthId: stagedSecret },
            },
        } as const;

        const created = await app.inject({
            method: "POST",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: { content, expiresAtMs, scope: oauthScope },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toMatchObject({ revision: 1, content, expiresAtMs, scope: oauthScope });

        const stored = await db.repeatKey.findMany();
        expect(stored).toHaveLength(1);
        expect(stored[0]?.value).not.toContain(verifier);
        expect(stored[0]?.value).not.toContain(stagedSecret);

        // Sealing is only useful if the exact envelope still comes back, through
        // the read path and through a later replace.
        const opened = await app.inject({
            method: "GET",
            url: transactionReadUrl(url),
            headers: { "x-test-user-id": account.id },
        });
        expect(opened.statusCode).toBe(200);
        expect(opened.json()).toMatchObject({ revision: 1, content, expiresAtMs, scope: oauthScope });

        const nextContent = {
            t: "plain",
            v: { version: 1, kind: "oauth", verifier, consumed: true },
        } as const;
        const replaced = await app.inject({
            method: "PATCH",
            url,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                expectedRevision: 1,
                content: nextContent,
                expiresAtMs,
                scope: oauthScope,
            },
        });
        expect(replaced.statusCode).toBe(200);
        expect(replaced.json()).toMatchObject({
            revision: 2,
            content: nextContent,
            expiresAtMs,
            scope: oauthScope,
        });
        const afterReplace = await db.repeatKey.findMany();
        expect(afterReplace[0]?.value).not.toContain(verifier);
    });

    it("admits each envelope kind against the persisted Account mode and refuses the other", async () => {
        const [plainAccount, e2eeAccount] = await Promise.all([
            createPlainAccount(),
            createE2eeAccount(),
        ]);
        const app = createTestApp();
        await app.ready();
        const expiresAtMs = Date.now() + 15 * 60_000;
        const plainUrl = "/v2/connect/connected-account-attempt-transactions/device/plain-attempt";
        const plainContent = { t: "plain", v: { version: 1, kind: "device" } } as const;

        const storedPlain = await app.inject({
            method: "POST",
            url: plainUrl,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": plainAccount.id,
            },
            payload: { content: plainContent, expiresAtMs, scope: deviceScope },
        });
        expect(storedPlain.statusCode).toBe(200);
        expect(storedPlain.json()).toMatchObject({
            revision: 1,
            content: plainContent,
            expiresAtMs,
            scope: deviceScope,
        });

        const plainAccountEncrypted = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/device/plain-mismatch",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": plainAccount.id,
            },
            payload: {
                content: { t: "encrypted", c: "opaque" },
                expiresAtMs,
                scope: deviceScope,
            },
        });
        expect(plainAccountEncrypted.statusCode).toBe(409);
        expect(plainAccountEncrypted.json()).toEqual({
            error: "connected_account_attempt_transaction_storage_mode_mismatch",
        });

        const e2eeAccountPlain = await app.inject({
            method: "POST",
            url: "/v2/connect/connected-account-attempt-transactions/device/e2ee-mismatch",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": e2eeAccount.id,
            },
            payload: { content: plainContent, expiresAtMs, scope: deviceScope },
        });
        expect(e2eeAccountPlain.statusCode).toBe(409);
        expect(e2eeAccountPlain.json()).toEqual({
            error: "connected_account_attempt_transaction_storage_mode_mismatch",
        });

        // Only the mode-matching write is stored; neither refusal left a row behind.
        const rows = await db.repeatKey.findMany();
        expect(rows).toHaveLength(1);
    });

    it("does not reopen, replace, or delete a retained attempt after its Account mode changes", async () => {
        const account = await createE2eeAccount();
        const app = createTestApp();
        await app.ready();
        const url = "/v2/connect/connected-account-attempt-transactions/oauth/mode-drift";
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": account.id,
        };
        const expiresAtMs = Date.now() + 15 * 60_000;
        const content = { t: "encrypted", c: "predecessor-ciphertext" } as const;
        expect((await app.inject({
            method: "POST",
            url,
            headers,
            payload: { content, expiresAtMs, scope: oauthScope },
        })).statusCode).toBe(200);

        await db.account.update({
            where: { id: account.id },
            data: { encryptionMode: "plain" },
        });

        for (const request of [{ method: "GET" as const }, {
            method: "PATCH" as const,
            payload: {
                expectedRevision: 1,
                content: { t: "plain", v: { replacement: true } },
                expiresAtMs,
                scope: oauthScope,
            },
        }, {
            method: "DELETE" as const,
            payload: { expectedRevision: 1 },
        }]) {
            const response = await app.inject({
                method: request.method,
                url: request.method === "GET" ? transactionReadUrl(url) : url,
                headers,
                ...(request.payload ? { payload: request.payload } : {}),
            });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({
                error: "connected_account_attempt_transaction_storage_mode_mismatch",
            });
        }
        expect(await db.repeatKey.count()).toBe(1);
    });

    it("reports retained corrupt predecessor attempts as unreadable rather than absent", async () => {
        const account = await createPlainAccount();
        const app = createTestApp();
        await app.ready();
        const url = "/v2/connect/connected-account-attempt-transactions/device/corrupt-predecessor";
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": account.id,
        };
        const expiresAtMs = Date.now() + 15 * 60_000;
        expect((await app.inject({
            method: "POST",
            url,
            headers,
            payload: {
                content: { t: "plain", v: { verifier: "preserve" } },
                expiresAtMs,
                scope: deviceScope,
            },
        })).statusCode).toBe(200);
        const stored = await db.repeatKey.findFirstOrThrow({
            select: { key: true },
        });
        await db.repeatKey.update({
            where: { key: stored.key },
            data: { value: "not-json" },
        });

        for (const request of [{ method: "GET" as const }, {
            method: "PATCH" as const,
            payload: {
                expectedRevision: 1,
                content: { t: "plain", v: { verifier: "replacement" } },
                expiresAtMs,
                scope: deviceScope,
            },
        }, {
            method: "DELETE" as const,
            payload: { expectedRevision: 1 },
        }]) {
            const response = await app.inject({
                method: request.method,
                url: request.method === "GET" ? transactionReadUrl(url) : url,
                headers,
                ...(request.payload ? { payload: request.payload } : {}),
            });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({
                error: "connected_account_attempt_transaction_unreadable",
            });
        }
        expect(await db.repeatKey.count()).toBe(1);
    });

    it("physically reclaims an expired exact attempt without imposing an invented per-account transaction quota", async () => {
        const [accountA, accountB] = await Promise.all([
            createE2eeAccount(),
            createE2eeAccount(),
        ]);
        const app = createTestApp();
        await app.ready();
        const headers = (account: { id: string }) => ({
            "content-type": "application/json" as const,
            "x-test-user-id": account.id,
        });
        const urlFor = (attemptId: string) =>
            `/v2/connect/connected-account-attempt-transactions/oauth/${attemptId}`;

        const abandoned = await app.inject({
            method: "POST",
            url: urlFor("abandoned-attempt"),
            headers: headers(accountA),
            payload: {
                content: { t: "encrypted", c: "opaque-abandoned" },
                expiresAtMs: Date.now() + 40,
                scope: oauthScope,
            },
        });
        expect(abandoned.statusCode).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 90));
        expect(await db.repeatKey.count()).toBe(1);

        // Exact access owns semantic expiry cleanup. The broader RepeatKey
        // retention worker remains a separately configured operator policy.
        const expired = await app.inject({
            method: "GET",
            url: transactionReadUrl(urlFor("abandoned-attempt")),
            headers: headers(accountA),
        });
        expect(expired.statusCode).toBe(404);
        expect(await db.repeatKey.count()).toBe(0);

        // Row-size and lifetime validation are real request/storage boundaries;
        // they do not derive an arbitrary count of legitimate concurrent flows.
        // SQLite has one physical writer, so exercise a realistic concurrent
        // burst before continuing past the rejected fixed-cap boundary.
        const admitted = await Promise.all(
            Array.from({ length: 4 }, (_, index) => app.inject({
                method: "POST",
                url: urlFor(`live-${index}`),
                headers: headers(accountA),
                payload: {
                    content: { t: "encrypted", c: `opaque-live-${index}` },
                    expiresAtMs: Date.now() + 15 * 60_000,
                    scope: oauthScope,
                },
            })),
        );
        for (const response of admitted) {
            expect(response.statusCode, response.body).toBe(200);
        }
        for (let index = 4; index < 20; index += 1) {
            const response = await app.inject({
                method: "POST",
                url: urlFor(`live-${index}`),
                headers: headers(accountA),
                payload: {
                    content: { t: "encrypted", c: `opaque-live-${index}` },
                    expiresAtMs: Date.now() + 15 * 60_000,
                    scope: oauthScope,
                },
            });
            expect(response.statusCode, response.body).toBe(200);
        }
        expect(await db.repeatKey.count()).toBe(20);

        const other = await app.inject({
            method: "POST",
            url: urlFor("other-account-attempt"),
            headers: headers(accountB),
            payload: {
                content: { t: "encrypted", c: "opaque-other" },
                expiresAtMs: Date.now() + 15 * 60_000,
                scope: oauthScope,
            },
        });
        expect(other.statusCode).toBe(200);
        expect(await db.repeatKey.count()).toBe(21);
    });

});
