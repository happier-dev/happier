import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    createPlainSessionOwnerMetadataEnvelopeV1,
    encodeBase64,
    encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    decodeBase64,
    computeContentPublicKeyFingerprint,
    type SessionMetadataTuplePatchV1,
} from "@happier-dev/protocol";

import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { registerSessionPatchRoute } from "./registerSessionPatchRoute";

const PATH = "/v2/sessions/:sessionId";
const OWNER_METADATA = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
const SHARED_METADATA = JSON.stringify({ v: 1 });
const UPDATED_SHARED_METADATA = JSON.stringify({ v: 1, summary: { text: "Updated", updatedAt: 1 } });

function routeFor(accountId: string, sessionId: string) {
    return createRouteTestBuilder({
        method: "PATCH",
        path: PATH,
        defaultRequest: {
            userId: accountId,
            params: { sessionId },
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: true,
                outcome: "accepted",
                declaration: { v: 1, protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION },
                upgradeRequired: null,
            },
        },
        registerRoutes(app) {
            registerSessionPatchRoute(app as never);
        },
    });
}

async function fixture(layout: 0 | 1 = 1, active = false) {
    const owner = await db.account.create({ data: { encryptionMode: "plain", publicKey: randomUUID() } });
    const viewer = await db.account.create({ data: { encryptionMode: "plain", publicKey: randomUUID() } });
    const session = await db.session.create({ data: {
        accountId: owner.id,
        tag: randomUUID(),
        encryptionMode: "plain",
        currentStorageState: "hosted",
        active,
        metadata: layout === 1 ? SHARED_METADATA : "legacy-metadata",
        metadataLayoutVersion: layout,
        ownerMetadata: layout === 1 ? JSON.stringify(OWNER_METADATA) : null,
        metadataVersion: 4,
        agentState: layout === 1 ? null : "legacy-agent",
        agentStateVersion: 8,
    } });
    await db.sessionShare.create({ data: {
        sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id,
        accessLevel: "edit", canApprovePermissions: false,
    } });
    return { owner, viewer, session, route: routeFor(owner.id, session.id) };
}

function ownerPatch(overrides: Partial<Extract<SessionMetadataTuplePatchV1, { mode: "owner" }>> = {}) {
    return {
        mode: "owner" as const,
        metadataLayoutVersion: 1 as const,
        expectedOwnerMetadata: OWNER_METADATA,
        sharedMetadata: { ciphertext: UPDATED_SHARED_METADATA, expectedVersion: 4 },
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, runtime: { permissionMode: "default" } }),
        agentState: { ciphertext: null, expectedVersion: 8 },
        ...overrides,
    };
}

describe("sessionRoutes v2 patch with the real metadata owner", () => {
    let harness: LightSqliteHarness;
    let emitUpdate: MockInstance<typeof eventRouter.emitUpdate>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-patch-route-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
            },
        });
    });

    beforeEach(() => {
        harness.restoreEnv();
        // Socket delivery is the only replaced boundary; admission, tuple CAS,
        // recipient selection and payload construction all run for real.
        emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it("admits the restricted runtime only through the exact-Session guard", () => {
        const route = routeFor("owner", "session");
        const entry = route.app.routes.get(`PATCH ${PATH}`);
        expect(entry?.opts.config).toMatchObject({ restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } });
        expect(entry?.opts.preHandler).toBe(route.app.authenticate);
    });

    it("handles the strict shared-editor tuple after persisted Runner admission", async () => {
        const f = await fixture();
        const installationPublicKey = new Uint8Array(32).fill(7);
        const installationId = randomUUID();
        const machine = await db.machine.create({ data: {
            id: randomUUID(),
            accountId: f.owner.id, metadata: encodePlainMachineStoredContent({ v: 1 }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
            kind: "ephemeral_session_runner", installationId, installationPublicKey,
        } });
        await db.accessKey.create({ data: {
            accountId: f.owner.id, machineId: machine.id, sessionId: f.session.id, data: "runner-access-key",
        } });
        const activation = await db.ephemeralRunnerActivation.create({ data: {
            id: randomUUID(), creatorAccountId: f.owner.id, creatorTokenEpoch: f.owner.tokenEpoch,
            draftId: randomUUID(), sessionId: f.session.id, machineId: machine.id,
            state: "materialized", workspacePolicy: "choose_on_endpoint", activationExpiresAt: null,
            homeServerIdentityId: "runner-home", activationSigningPublicKey: "a".repeat(43),
            authoringCommitment: "b".repeat(43),
            artifact: { product: "happier-runner", version: "0.3.0", target: "linux-x64", sha256: "c".repeat(64) },
            endpointFactsRecipient: { mode: "plain", creatorAccountId: f.owner.id },
        } });
        const result = await f.route.invoke({
            authTokenKind: "ephemeral_session_runner", authAuthority: "account_automation",
            sessionRuntimePrincipal: {
                kind: "ephemeral_session_runner", authority: "session_runtime", accountId: f.owner.id,
                activationId: activation.id, sessionId: f.session.id, machineId: machine.id,
                installationId,
                installationPublicKey: encodeBase64(installationPublicKey, "base64url"),
                creatorTokenEpoch: f.owner.tokenEpoch,
            },
            body: { mode: "shared_editor", metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: UPDATED_SHARED_METADATA, expectedVersion: 4 } },
        });
        expect(result.reply.statusCode).toBe(200);
        expect(result.response).toEqual({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 5 } });
        expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).metadata).toBe(UPDATED_SHARED_METADATA);
    });

    it("publishes a legacy mutation to its owner using the committed Account cursor", async () => {
        const f = await fixture(0);
        const result = await f.route.invoke({ body: {
            metadata: { ciphertext: "legacy-updated", expectedVersion: 4 },
            agentState: { ciphertext: null, expectedVersion: 8 },
        } });
        expect(result.response).toEqual({ success: true, metadata: { version: 5 }, agentState: { version: 9 } });
        const ownerCursor = (await db.account.findUniqueOrThrow({ where: { id: f.owner.id } })).seq;
        expect(emitUpdate.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
            userId: f.owner.id, payload: expect.objectContaining({
                seq: ownerCursor, body: expect.objectContaining({ t: "update-session",
                    metadata: { value: "legacy-updated", version: 5 }, agentState: { value: null, version: 9 } }),
            }),
        }));
        expect(emitUpdate.mock.calls.some(([event]) => event.userId === f.viewer.id && event.payload.body.t === "update-session")).toBe(false);
    });

    it.each([0, 1] as const)("refuses an active conditioned mutation in layout %s without writing or publishing", async layout => {
        const f = await fixture(layout, true);
        const body = layout === 0 ? {
            inactiveModelIntent: { metadata: { ciphertext: "inactive-model-intent", expectedVersion: 4 },
                sessionExpectation: { kind: "inactive_model_intent" } },
        } : { ...ownerPatch(), mode: "owner_inactive_model_intent",
            sessionExpectation: { kind: "inactive_model_intent" } };
        const result = await f.route.invoke({ body });
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ code: "session_active" });
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(f.session);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns the strict inactive-model-intent success shape from a persisted write", async () => {
        const f = await fixture(0);
        const result = await f.route.invoke({ body: { inactiveModelIntent: {
            metadata: { ciphertext: "inactive-model-intent", expectedVersion: 4 },
            sessionExpectation: { kind: "inactive_model_intent" },
        } } });
        expect(result.response).toEqual({ success: true, metadata: { version: 5 } });
    });

    it("keeps inactive-model-intent conflicts limited to the public metadata tuple", async () => {
        const f = await fixture(0);
        const result = await f.route.invoke({ body: { inactiveModelIntent: {
            metadata: { ciphertext: "stale", expectedVersion: 3 },
            sessionExpectation: { kind: "inactive_model_intent" },
        } } });
        expect(result.response).toEqual({ success: false, error: "version-mismatch",
            metadata: { version: 4, value: "legacy-metadata" } });
        expect(JSON.stringify(result.response)).not.toContain("legacy-agent");
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns current legacy values on a version mismatch", async () => {
        const f = await fixture(0);
        const result = await f.route.invoke({ body: {
            metadata: { ciphertext: "stale", expectedVersion: 3 },
            agentState: { ciphertext: null, expectedVersion: 7 },
        } });
        expect(result.response).toEqual({ success: false, error: "version-mismatch",
            metadata: { version: 4, value: "legacy-metadata" },
            agentState: { version: 8, value: "legacy-agent" } });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("returns an internal failure without publication when the database transaction fails", async () => {
        const f = await fixture(0);
        // A database failure is reachable; an owner-generated mismatch without
        // its current vector is not. Exercise the real failure boundary instead.
        // The client proxy forwards assignments but exposes no property
        // descriptor for spyOn. Replace and restore the database method itself.
        const transaction = db.$transaction;
        db.$transaction = () => { throw new Error("database unavailable"); };
        try {
            const result = await f.route.invoke({ body: { metadata: { ciphertext: "updated", expectedVersion: 4 } } });
            expect(result.reply.statusCode).toBe(500);
            expect(result.response).toEqual({ error: "Failed to update session" });
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            db.$transaction = transaction;
        }
    });

    it("refuses a legacy whole-bag write to layout one", async () => {
        const f = await fixture();
        const result = await f.route.invoke({ body: { metadata: { ciphertext: "legacy-whole-bag", expectedVersion: 4 } } });
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ error: "Session metadata privacy upgrade required", code: "metadata_privacy_upgrade_required" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("refuses owner migration when the captured Account mode does not match", async () => {
        const f = await fixture(0);
        const result = await f.route.invoke({ body: {
            mode: "owner_migration", expectedAccountEncryptionMode: "e2ee",
            expectedAccountContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(new Uint8Array(32).fill(5)),
            source: { metadataLayoutVersion: 0, metadata: { version: 4, ciphertext: "legacy-metadata" },
                ownerMetadata: null, agentState: { version: 8, ciphertext: "legacy-agent" } },
            target: { metadataLayoutVersion: 1, sharedMetadata: { ciphertext: UPDATED_SHARED_METADATA },
                ownerMetadata: OWNER_METADATA, agentState: { ciphertext: null } },
        } });
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ error: "Session metadata privacy upgrade required", code: "metadata_privacy_upgrade_required" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("commits the owner tuple once, returns the complete version vector and projects each recipient", async () => {
        const f = await fixture();
        const result = await f.route.invoke({ body: ownerPatch() });
        expect(result.response).toEqual({ success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: 5 }, agentState: { version: 8 } });
        const stored = await db.session.findUniqueOrThrow({ where: { id: f.session.id } });
        expect(stored.metadata).toBe(UPDATED_SHARED_METADATA);
        expect(stored.metadataVersion).toBe(5);
        const publications = emitUpdate.mock.calls.map(([event]) => event);
        expect(publications).toContainEqual(expect.objectContaining({
            userId: f.owner.id, payload: expect.objectContaining({ body: expect.objectContaining({
                t: "update-session", metadataLayoutVersion: 1, ownerMetadata: expect.any(Object),
            }) }),
        }));
        const shared = publications.filter(event => event.userId === f.viewer.id && event.payload.body.t === "update-session");
        expect(shared.length).toBeGreaterThan(0);
        for (const event of shared) {
            expect(event.payload.body).not.toHaveProperty("ownerMetadata");
            expect(event.payload.body).toMatchObject({ metadata: { version: 5, value: UPDATED_SHARED_METADATA } });
        }
    });

    it("returns typed publisher-authority loss without changing or publishing the tuple", async () => {
        const f = await fixture();
        const result = await f.route.invoke({ body: { ...ownerPatch(), publisherPrecondition: {
            machineId: randomUUID(), committedFenceMs: 42, publisherGeneration: "1",
        } } });
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ code: "session_publisher_authority_lost" });
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(f.session);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("publishes a shared-editor write without exposing owner-only fields", async () => {
        const f = await fixture();
        const result = await routeFor(f.viewer.id, f.session.id).invoke({ body: {
            mode: "shared_editor", metadataLayoutVersion: 1,
            sharedMetadata: { ciphertext: UPDATED_SHARED_METADATA, expectedVersion: 4 },
        } });
        expect(result.response).toEqual({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 5 } });
        const stored = await db.session.findUniqueOrThrow({ where: { id: f.session.id } });
        expect(stored.ownerMetadata).toBe(f.session.ownerMetadata);
        const shared = emitUpdate.mock.calls.filter(([event]) => event.userId === f.viewer.id && event.payload.body.t === "update-session");
        expect(shared.length).toBeGreaterThan(0);
        for (const [event] of shared) expect(event.payload.body).not.toHaveProperty("ownerMetadata");
    });

    it("returns a typed version vector without ciphertext on tuple CAS loss", async () => {
        const f = await fixture();
        const result = await f.route.invoke({ body: ownerPatch({
            sharedMetadata: { ciphertext: UPDATED_SHARED_METADATA, expectedVersion: 3 },
            agentState: { ciphertext: null, expectedVersion: 7 },
        }) });
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ code: "session_metadata_version_conflict", metadataLayoutVersion: 1,
            sharedMetadata: { version: 4 }, agentState: { version: 8 } });
        expect(JSON.stringify(result.response)).not.toContain(SHARED_METADATA);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it.each(["owner", "shared_editor"] as const)("refuses a persisted future layout before a %s mutation or publication", async mode => {
        const f = await fixture();
        await db.session.update({ where: { id: f.session.id }, data: { metadataLayoutVersion: 2 } });
        const result = await f.route.invoke({ body: mode === "owner" ? ownerPatch() : {
            mode, metadataLayoutVersion: 1, sharedMetadata: { ciphertext: UPDATED_SHARED_METADATA, expectedVersion: 4 },
        } });
        expect(result.reply.statusCode).toBe(409);
        expect(result.response).toEqual({ error: "Session metadata privacy upgrade required", code: "metadata_privacy_upgrade_required" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it.each([["1", 403, "session_access_authentication_required"], ["0", 503, "session_access_authentication_unavailable"]] as const)(
        "preserves Team authentication status when key challenge is enabled=%s", async (enabled, status, error) => {
            const f = await fixture();
            await db.sessionShare.deleteMany({ where: { sessionId: f.session.id } });
            const team = await db.team.create({ data: { name: randomUUID(), authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } } });
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: f.owner.id, role: "owner" },
                { teamId: team.id, accountId: f.viewer.id, role: "member" },
            ] });
            await db.sessionTeamGrant.create({ data: {
                sessionId: f.session.id, teamId: team.id, accessLevel: "edit", effectiveAt: new Date(),
            } });
            process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = enabled;
            const result = await routeFor(f.viewer.id, f.session.id).invoke({ body: {
                mode: "shared_editor", metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: UPDATED_SHARED_METADATA, expectedVersion: 4 },
            } });
            expect(result.reply.statusCode).toBe(status);
            expect(result.response).toEqual({ error });
            expect(emitUpdate).not.toHaveBeenCalled();
        },
    );

    it.each([
        { mode: "shared_editor", metadataLayoutVersion: 1, sharedMetadata: { ciphertext: "shared", expectedVersion: 1 }, ownerMetadata: OWNER_METADATA },
        { agentState: { ciphertext: "agent-state-only", expectedVersion: 1 }, sessionExpectation: { kind: "inactive_model_intent" } },
    ])("rejects branch extras rather than silently selecting another mutation mode", body => {
        const route = routeFor("owner", "session");
        const schema = route.app.routes.get(`PATCH ${PATH}`)?.opts.schema as { body: { safeParse(value: unknown): { success: boolean } } };
        expect(schema.body.safeParse(body).success).toBe(false);
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
