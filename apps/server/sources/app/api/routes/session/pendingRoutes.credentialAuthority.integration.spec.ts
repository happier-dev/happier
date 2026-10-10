import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import { createMaterializedEphemeralRunnerFixture } from "@/app/ephemeralRunner/materializedRunner.testkit";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { sessionPendingRoutes } from "./pendingRoutes";

function createApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    enableAuthentication(typed);
    sessionPendingRoutes(typed);
    return app;
}

function headers(token: string) {
    return { authorization: `Bearer ${token}`, "x-happier-account-stored-content-protocol": "2" };
}

function content(text: string) {
    return { t: "plain" as const, v: { role: "user", content: { type: "text", text } } };
}

describe("Pending HTTP credential authority (integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-credential-authority-",
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it("admits bound Runner mutations as shared-editor input, never owner activation", async () => {
        // The canonical route contract binds the ordinary runtime to its exact
        // Session; the Session owner, not a transport operation allowlist,
        // decides the resulting capability and input relationship.
        const fixture = await createMaterializedEphemeralRunnerFixture({ sessionActive: false });
        const app = createApp();
        const base = `/v2/sessions/${fixture.sessionId}/pending`;
        const localId = randomUUID();
        try {
            const enqueue = await app.inject({ method: "POST", url: base, headers: headers(fixture.token),
                payload: { localId, content: content("Runner input"), requestedAction: { v: 1, kind: "enqueue" } } });
            expect(enqueue.statusCode, enqueue.body).toBe(200);
            expect((await db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: fixture.sessionId, localId } },
            })).inputAdmissionReceipt).toEqual({
                v: 1, issuer: "authenticatedAccount", actorAccountId: fixture.accountId, sessionRelationship: "sharedEditor",
            });

            const action = await app.inject({ method: "PATCH", url: `${base}/${localId}/action`, headers: headers(fixture.token),
                payload: { requestedAction: { v: 1, kind: "send_now" }, resumeWhenAvailable: true } });
            expect(action.statusCode, action.body).toBe(200);
            expect((await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } })).pendingActivationRequestId).toBeNull();

            const update = await app.inject({ method: "PATCH", url: `${base}/${localId}`, headers: headers(fixture.token),
                payload: { content: content("Changed Runner input") } });
            expect(update.statusCode, update.body).toBe(200);
            expect((await db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: fixture.sessionId, localId } },
            })).content).toEqual(content("Changed Runner input"));

            const discard = await app.inject({ method: "POST", url: `${base}/${localId}/discard`, headers: headers(fixture.token),
                payload: { reason: "manual" } });
            expect(discard.statusCode, discard.body).toBe(200);
            expect((await db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: fixture.sessionId, localId } },
            })).status).toBe("discarded");
            const deletion = await app.inject({ method: "DELETE", url: `${base}/${localId}`, headers: headers(fixture.token) });
            expect(deletion.statusCode, deletion.body).toBe(200);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: fixture.sessionId } })).toBe(0);
        } finally { await app.close(); }
    });

    it("rejects sibling targets and unbound operations, while retaining present-user access", async () => {
        const fixture = await createMaterializedEphemeralRunnerFixture();
        const sibling = await db.session.create({ data: {
            accountId: fixture.accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const app = createApp();
        const localId = randomUUID();
        const base = `/v2/sessions/${fixture.sessionId}/pending`;
        try {
            const enqueue = await app.inject({ method: "POST", url: base, headers: headers(fixture.accountToken),
                payload: { localId, content: content("Owner input") } });
            expect(enqueue.statusCode, enqueue.body).toBe(200);
            const snapshot = await db.sessionPendingMessage.findMany({ where: { sessionId: fixture.sessionId } });
            for (const operation of [
                { method: "GET", suffix: "" },
                { method: "POST", suffix: "", payload: { localId, content: content("Wrong Session") } },
                { method: "PATCH", suffix: `/${localId}`, payload: { content: content("Wrong Session") } },
                { method: "PATCH", suffix: `/${localId}/action`, payload: { requestedAction: { v: 1, kind: "send_now" } } },
                { method: "DELETE", suffix: `/${localId}` },
                { method: "POST", suffix: `/${localId}/discard`, payload: { reason: "manual" } },
            ] as const) {
                const response = await app.inject({ method: operation.method,
                    url: `/v2/sessions/${sibling.id}/pending${operation.suffix}`, headers: headers(fixture.token),
                    ...("payload" in operation ? { payload: operation.payload } : {}) });
                expect(response.statusCode, response.body).toBe(403);
                expect(response.json()).toEqual({ error: "present_user_required" });
            }
            const reorder = { method: "POST" as const, url: `${base}/reorder`, payload: { orderedLocalIds: [localId] } };
            const denied = await app.inject({ ...reorder, headers: headers(fixture.token) });
            expect(denied.statusCode, denied.body).toBe(403);
            expect(denied.json()).toEqual({ error: "present_user_required" });
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: fixture.sessionId } })).toEqual(snapshot);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: sibling.id } })).toBe(0);
            const allowed = await app.inject({ ...reorder, headers: headers(fixture.accountToken) });
            expect(allowed.statusCode, allowed.body).toBe(200);
        } finally { await app.close(); }
    });

    it.each([
        ["Runner", "enqueue"],
        ["Runner", "send_now"],
        ["shared editor", "send_now"],
    ] as const)("does not borrow an existing owner's receipt for %s %s activation", async (caller, kind) => {
        const fixture = await createMaterializedEphemeralRunnerFixture({ sessionActive: false });
        let mutationToken = fixture.token;
        if (caller === "shared editor") {
            const editor = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            await db.session.update({ where: { id: fixture.sessionId }, data: { currentStorageState: "hosted" } });
            await db.sessionShare.create({ data: { sessionId: fixture.sessionId, sharedByUserId: fixture.accountId,
                sharedWithUserId: editor.id, accessLevel: "edit", canApprovePermissions: false } });
            mutationToken = await auth.createToken(editor.id, undefined, { kind: "account", authority: "present_user" });
        }
        const app = createApp();
        const localId = randomUUID();
        const base = `/v2/sessions/${fixture.sessionId}/pending`;
        try {
            const enqueue = await app.inject({ method: "POST", url: base, headers: headers(fixture.accountToken),
                payload: { localId, content: content("Owner queued input") } });
            expect(enqueue.statusCode, enqueue.body).toBe(200);
            const originalReceipt = (await db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: fixture.sessionId, localId } },
            })).inputAdmissionReceipt;
            expect(originalReceipt).toMatchObject({ sessionRelationship: "owner" });

            const runner = await app.inject({ method: "PATCH", url: `${base}/${localId}/action`, headers: headers(mutationToken),
                payload: { requestedAction: { v: 1, kind }, resumeWhenAvailable: true } });
            expect(runner.statusCode, runner.body).toBe(200);
            expect((await db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: fixture.sessionId, localId } },
            })).inputAdmissionReceipt).toEqual(originalReceipt);
            expect((await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } })).pendingActivationRequestId).toBeNull();

            const owner = await app.inject({ method: "PATCH", url: `${base}/${localId}/action`, headers: headers(fixture.accountToken),
                payload: { requestedAction: { v: 1, kind }, resumeWhenAvailable: true } });
            expect(owner.statusCode, owner.body).toBe(200);
            expect((await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } })).pendingActivationRequestId).toBe(localId);
        } finally { await app.close(); }
    });

    it("enforces PAT Action and target grants independently of Runner admission and rechecks revocation", async () => {
        const fixture = await createMaterializedEphemeralRunnerFixture();
        const base = `/v2/sessions/${fixture.sessionId}/pending`;
        const sibling = await db.session.create({ data: {
            accountId: fixture.accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ["session.message.send", "session.transcript.get"] },
            targets: { sessions: [fixture.sessionId], machines: [] },
        });
        const allowedPat = await auth.createApiToken({ accountId: fixture.accountId, tokenId: randomUUID(), label: "Pending input", grant });
        const deniedPat = await auth.createApiToken({ accountId: fixture.accountId, tokenId: randomUUID(), label: "Read only",
            grant: { ...grant, actions: { families: [], ids: ["session.transcript.get"] } } });
        const app = createApp();
        const localId = randomUUID();
        try {
            const denied = await app.inject({ method: "POST", url: base, headers: headers(deniedPat.token),
                payload: { localId, content: content("Denied input") } });
            expect(denied.statusCode, denied.body).toBe(403);
            expect(denied.json()).toEqual({ error: "credential_scope_denied" });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: fixture.sessionId } })).toBe(0);
            const wrongTarget = await app.inject({ method: "POST", url: `/v2/sessions/${sibling.id}/pending`,
                headers: headers(allowedPat.token), payload: { localId, content: content("Wrong target") } });
            expect(wrongTarget.statusCode, wrongTarget.body).toBe(403);
            expect(wrongTarget.json()).toEqual({ error: "credential_scope_denied" });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: sibling.id } })).toBe(0);
            const allowed = await app.inject({ method: "POST", url: base, headers: headers(allowedPat.token),
                payload: { localId, content: content("Granted input") } });
            expect(allowed.statusCode, allowed.body).toBe(200);
            const read = await app.inject({ method: "GET", url: base, headers: headers(fixture.token) });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json().pending).toEqual([expect.objectContaining({ localId })]);

            await db.accessKey.deleteMany({ where: { accountId: fixture.accountId, sessionId: fixture.sessionId, machineId: fixture.machineId } });
            const revoked = await app.inject({ method: "POST", url: base, headers: headers(fixture.token),
                payload: { localId: randomUUID(), content: content("Revoked input") } });
            expect(revoked.statusCode, revoked.body).toBe(401);
            expect(revoked.json()).toEqual({ error: "invalid_token" });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: fixture.sessionId } })).toBe(1);
        } finally { await app.close(); }
    });
});
