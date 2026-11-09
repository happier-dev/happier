import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    encodeSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionPatchRoute } from "@/app/api/routes/session/registerSessionPatchRoute";
import { inTx } from "@/storage/inTx";
import { prepareSessionMetadataTuplePatchV1, updateSessionMetadataTupleWithRetry } from "@happier-dev/cli-common/sessionMetadata";
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilityHttpHeadersV1 } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";
import { SessionMetadataTuplePatchSuccessV1Schema } from "@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1";
import { SessionFollowInputV1Schema } from "@happier-dev/protocol/sessions/follow/sessionFollowInputV1";
import { admitSessionFollowRelationsForInputInTx } from "./follow/sessionFollowEdgeService";
import { setSessionManager } from "./follow/sessionManagerService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "./access/sessionAccessAuthentication.testkit";
import { loadSessionViewerProjection } from "./personal/projection";
import { applySessionTurnMutation, patchSession, patchSessionInTx, updateSessionAgentState, updateSessionMetadata, updateSessionMetadataEnvelopeTuple, updateSessionMetadataEnvelopeTupleInTx, type UpdateSessionMetadataEnvelopeTupleInput } from "./sessionWriteService";
import * as sessionAccessWhereOwner from "./access/sessionAccessWhere";
import * as sessionAccessOwner from "./access/sessionAccess";
import * as accountContentKeyOwner from "@/app/encryption/accountContentKeyAdmission";

describe("Session metadata tuple pending summary (SQLite)", () => {
    let harness: LightSqliteHarness;
    const authentication = createPresentUserSessionAccessAuthentication();
    const ownerEnvelope = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
    const pendingSummary = { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestNewestCreatedAt: 100 };
    const settledSummary = { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestNewestCreatedAt: null };

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-metadata-pending-summary-", initAuth: false, initEncrypt: false, initFiles: false,
        });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it("migrates retained plain metadata without changing values before applying the ordinary edit", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const metadata = { path: "/private/owner/repo", host: "owner-machine", summary: { text: "Before", updatedAt: 1 } };
        const agentState = { controlledByUser: false };
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: "plain", metadataLayoutVersion: 0, metadata: JSON.stringify(metadata),
            metadataVersion: 2, agentState: JSON.stringify(agentState), agentStateVersion: 4 } });
        const app = createAuthenticatedTestApp();
        const patches: unknown[] = [];
        registerSessionPatchRoute(app);
        await app.ready();
        try {
            await expect(updateSessionMetadataTupleWithRetry({
                initialSnapshot: { mode: "legacy_owner", metadataLayoutVersion: 0,
                    metadataVersion: session.metadataVersion, metadataCiphertext: session.metadata, ownerMetadata: null,
                    agentStateVersion: session.agentStateVersion, agentStateCiphertext: session.agentState,
                    value: { metadata, agentState } },
                mutation: { kind: "metadata", update: current => ({ ...current, summary: { text: "After", updatedAt: 2 } }) },
                crypto: { encryptPayload: async payload => JSON.stringify(payload),
                    encodeOwnerMetadata: createPlainSessionOwnerMetadataEnvelopeV1 },
                ownerMigrationCurrentness: { expectedAccountEncryptionMode: "plain", expectedAccountContentPublicKeyFingerprint: null },
                commit: async patch => {
                    patches.push(patch);
                    const response = await app.inject({ method: "PATCH", url: `/v2/sessions/${session.id}`,
                        headers: { "x-test-user-id": owner.id,
                            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
                        payload: patch });
                    expect(response.statusCode).toBe(200);
                    const body = SessionMetadataTuplePatchSuccessV1Schema.parse(response.json());
                    return { result: "success", metadataVersion: body.sharedMetadata.version,
                        agentStateVersion: body.agentState?.version };
                },
            })).resolves.toMatchObject({ metadataVersion: 4, value: { metadata: { ...metadata, summary: { text: "After", updatedAt: 2 } } } });
            expect(patches).toMatchObject([
                { mode: "owner_migration", source: { metadata: { version: 2 }, agentState: { version: 4 } },
                    target: { sharedMetadata: { ciphertext: expect.stringContaining("Before") },
                        agentState: { ciphertext: JSON.stringify(agentState) } } },
                { mode: "owner", sharedMetadata: { expectedVersion: 3, ciphertext: expect.stringContaining("After") },
                    agentState: { expectedVersion: 5, ciphertext: JSON.stringify(agentState) } },
            ]);
            const stored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(stored).toMatchObject({ metadataLayoutVersion: 1, metadataVersion: 4, agentStateVersion: 5 });
            expect(stored.metadata).not.toContain(metadata.path);
            expect(stored.metadata).not.toContain(metadata.host);
            expect(stored.ownerMetadata).toContain(metadata.path);
            expect(JSON.parse(stored.agentState!)).toEqual(agentState);
        } finally {
            await app.close();
        }
    });

    async function seed(layout = 1) {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: "plain", active: true, currentStorageState: "hosted",
            metadataLayoutVersion: layout, metadata: layout === 1 ? JSON.stringify({ v: 1 }) : "{}",
            ownerMetadata: layout === 1 ? encodeSessionOwnerMetadataEnvelopeV1(ownerEnvelope) : null,
            agentState: "{}",
        } });
        const readSummary = () => db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
            pendingPermissionRequestCount: true, pendingUserActionRequestCount: true, pendingRequestObservedAt: true,
        } });
        const readViewer = () => loadSessionViewerProjection({ accountId: account.id, sessionId: session.id, authentication });
        const ownerPatch = (expectedVersion: number, expectedAgentStateVersion = expectedVersion) => ({
            mode: "owner" as const, actorUserId: account.id, sessionId: session.id, metadataLayoutVersion: 1 as const,
            expectedOwnerMetadata: ownerEnvelope, ownerMetadata: ownerEnvelope,
            sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }), expectedVersion },
            agentState: { ciphertext: "{}", expectedVersion: expectedAgentStateVersion },
        });
        return { account, session, readSummary, readViewer, ownerPatch };
    }

    it.each(['metadata', 'atomic_patch'] as const)('reuses one admitted legacy owner decision for %s and refuses the next outsider request', async entry => {
        const current = await seed(0);
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const admission = vi.spyOn(sessionAccessOwner, 'resolveSessionAccessForOperation');
        const ownerAssertion = vi.spyOn(sessionAccessOwner, 'assertSessionOwnerInTx');
        const commit = (actorUserId: string, expectedVersion: number) => entry === 'metadata'
            ? updateSessionMetadata({ actorUserId, sessionId: current.session.id, authentication, expectedVersion,
                metadataCiphertext: '{"summary":{"text":"Admitted","updatedAt":1}}' })
            : patchSession({ actorUserId, sessionId: current.session.id, authentication,
                metadata: { expectedVersion, ciphertext: '{"summary":{"text":"Admitted","updatedAt":1}}' } });
        try {
            expect(await commit(current.account.id, 0)).toMatchObject({ ok: true });
            expect(admission.mock.calls.length).toBe(1);
            expect(ownerAssertion.mock.calls.length).toBe(0);
            const committed = await db.session.findUniqueOrThrow({ where: { id: current.session.id } });
            expect(committed).toMatchObject({ metadataVersion: 1, metadata: expect.stringContaining('Admitted') });
            expect(await commit(outsider.id, 1)).toMatchObject({ ok: false, error: 'forbidden' });
            expect(admission.mock.calls.length).toBe(2);
            expect(ownerAssertion.mock.calls.length).toBe(0);
            expect(await db.session.findUniqueOrThrow({ where: { id: current.session.id } })).toEqual(committed);
        } finally { admission.mockRestore(); ownerAssertion.mockRestore(); }
    });

    it('admits direct transaction-local legacy patches once and refuses an outsider without a prior admission', async () => {
        const current = await seed(0);
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerAssertion = vi.spyOn(sessionAccessOwner, 'assertSessionOwnerInTx');
        const commit = (actorUserId: string, expectedVersion: number) => inTx(tx => patchSessionInTx(tx, {
            actorUserId, sessionId: current.session.id, metadata: { ciphertext: '{"summary":{"text":"Direct","updatedAt":1}}', expectedVersion },
        }));
        try {
            expect(await commit(current.account.id, 0)).toMatchObject({ ok: true, metadata: { version: 1 } });
            expect(ownerAssertion.mock.calls.length).toBe(1);
            const committed = await db.session.findUniqueOrThrow({ where: { id: current.session.id } });
            expect(await commit(outsider.id, 1)).toMatchObject({ ok: false, error: 'forbidden' });
            expect(ownerAssertion.mock.calls.length).toBe(2);
            expect(await db.session.findUniqueOrThrow({ where: { id: current.session.id } })).toEqual(committed);
        } finally { ownerAssertion.mockRestore(); }
    });

    it.each(['public', 'in_transaction'] as const)('rejects unknown metadata mutation fields through the %s owner entry before writing a valid tuple', async entry => {
        const current = await seed();
        const patch = current.ownerPatch(0);
        const commit = (input: UpdateSessionMetadataEnvelopeTupleInput) => entry === 'public'
            ? updateSessionMetadataEnvelopeTuple(input)
            : inTx(tx => updateSessionMetadataEnvelopeTupleInTx(tx, input));
        const before = await db.session.findUniqueOrThrow({ where: { id: current.session.id } });
        const invalidPatches = [
            { ...patch, unexpectedMutationField: true },
            { ...patch, sharedMetadata: { ...patch.sharedMetadata, unexpectedMutationField: true } },
        ];
        for (const invalid of invalidPatches) {
            expect(await commit(invalid)).toMatchObject({ ok: false, error: 'invalid-params' });
            expect(await db.session.findUniqueOrThrow({ where: { id: current.session.id } })).toEqual(before);
        }
        expect(await commit({ ...patch, sharedMetadata: { ciphertext: '{"v":1,"summary":{"text":"Accepted","updatedAt":1}}', expectedVersion: 0 } }))
            .toMatchObject({ ok: true, sharedMetadata: { version: 1 } });
        expect(await db.session.findUniqueOrThrow({ where: { id: current.session.id } }))
            .toMatchObject({ metadataVersion: 1, metadata: expect.stringContaining('Accepted') });
    });

    it("uses the admitted Team editor scope for its tuple CAS and refuses the next edit after membership is withdrawn", async () => {
        const current = await seed();
        const editor = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Metadata editor ${randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { accountId: current.account.id, teamId: team.id, role: "owner", sessionAccessStartsAt: null },
            { accountId: editor.id, teamId: team.id, role: "member", sessionAccessStartsAt: null },
        ] });
        await db.sessionTeamGrant.create({ data: { sessionId: current.session.id, teamId: team.id,
            accessLevel: "admin", effectiveAt: new Date(0) } });
        const patch = { mode: "shared_editor" as const, mutationIntent: "rename_session" as const,
            actorUserId: editor.id, authentication, sessionId: current.session.id, metadataLayoutVersion: 1 as const,
            sharedMetadata: { ciphertext: JSON.stringify({ v: 1, summary: { text: "Renamed", updatedAt: 1 } }), expectedVersion: 0 } };
        const policyPredicates = vi.spyOn(sessionAccessWhereOwner, "buildSessionAccessWhere");
        try {
            expect(await updateSessionMetadataEnvelopeTuple(patch)).toMatchObject({ ok: true,
                sharedMetadata: { version: 1 } });
            expect(await db.session.findUniqueOrThrow({ where: { id: current.session.id },
                select: { ownerMetadata: true, metadata: true } }))
                .toEqual({ ownerMetadata: current.session.ownerMetadata, metadata: patch.sharedMetadata.ciphertext });
            expect(policyPredicates.mock.calls.length).toBe(0);
            await db.teamMembership.delete({ where: { teamId_accountId: { teamId: team.id, accountId: editor.id } } });
            expect(await updateSessionMetadataEnvelopeTuple({ ...patch,
                sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }), expectedVersion: 1 } }))
                .toMatchObject({ ok: false, error: "forbidden" });
            expect((await db.session.findUniqueOrThrow({ where: { id: current.session.id } })).metadataVersion).toBe(1);
        } finally { policyPredicates.mockRestore(); }
    });

    it("derives Account crypto currentness once for an admitted owner tuple", async () => {
        const current = await seed();
        // Observe the real crypto owner without replacing its validation logic.
        const derivations = vi.spyOn(accountContentKeyOwner, "deriveAccountEncryptionCurrentnessFromRow");
        try {
            expect(await updateSessionMetadataEnvelopeTuple({ ...current.ownerPatch(0),
                sharedMetadata: { expectedVersion: 0,
                    ciphertext: JSON.stringify({ v: 1, summary: { text: "Current owner", updatedAt: 1 } }) } }))
                .toMatchObject({ ok: true, sharedMetadata: { version: 1 } });
            expect(derivations.mock.calls.length).toBe(1);
            expect((await db.session.findUniqueOrThrow({ where: { id: current.session.id } })).metadataVersion).toBe(1);
        } finally { derivations.mockRestore(); }
    });

    it("keeps a fresh question admission current across a metadata-only tuple commit, but not a real request change", async () => {
        const current = await seed();
        const manager = await db.session.create({ data: { accountId: current.account.id, tag: randomUUID(),
            encryptionMode: "plain", metadata: "{}" } });
        expect(await setSessionManager({ accountId: current.account.id, sessionId: current.session.id,
            managerSessionId: manager.id, expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        const handler = { kind: "session" as const, sessionId: manager.id };
        const requestId = randomUUID();
        const agentState = { requests: { [requestId]: { tool: "AskUserQuestion", kind: "user_action", createdAt: 100,
            arguments: { questions: [{ question: "Region?" }] }, questionV1: { mode: "wait", lasting: false }, currentHandler: handler } } };
        const requestBytes = JSON.stringify(agentState);
        // Initial persisted source fixture; all mutations below use the real tuple owner.
        await db.session.update({ where: { id: current.session.id }, data: { agentState: requestBytes, agentStateVersion: 7 } });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: "wake", original: {
            sourceSessionId: current.session.id, sourceRequests: { agentStateVersion: 7,
                requests: [{ requestId, createdAt: 100, currentHandler: handler }] } },
            requestEvents: [{ requestId, event: { kind: "needs_you", type: "decision", mode: "wait", handling: "manager" } }] });
        const admit = () => inTx(tx => admitSessionFollowRelationsForInputInTx(tx, {
            accountId: current.account.id, destinationSessionId: manager.id, authentication, delivery, relations: [],
        }));
        expect(await admit()).not.toBeNull();
        const patch = await prepareSessionMetadataTuplePatchV1({ current: {
            mode: "owner", metadataLayoutVersion: 1, metadataVersion: 0, agentStateVersion: 7,
            sharedMetadataCiphertext: current.session.metadata, ownerMetadataEnvelope: ownerEnvelope,
            agentStateCiphertext: requestBytes, value: { metadata: {}, sharedMetadata: { v: 1 }, ownerMetadata: { v: 1 }, agentState },
        }, mutation: { kind: "metadata", update: metadata => ({ ...metadata, summary: { text: "Question waiting", updatedAt: 200 } }) },
            crypto: { encryptPayload: async value => JSON.stringify(value),
                encodeOwnerMetadata: value => createPlainSessionOwnerMetadataEnvelopeV1(value) } });
        if (!patch || patch.mode !== "owner") throw new Error("Expected owner tuple patch");
        const commit = () => updateSessionMetadataEnvelopeTuple({ ...patch, actorUserId: current.account.id,
            sessionId: current.session.id });
        const receiverCursor = await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: current.account.id, kind: "account", entityId: `session-follow-receiver:${manager.id}` } } });
        expect(receiverCursor).not.toBeNull();
        expect(await commit()).toMatchObject({ ok: true, agentState: { version: 7 } });
        expect(await admit(), "metadata does not invalidate the first exact question offer").not.toBeNull();
        expect(await commit()).toMatchObject({ ok: true, agentState: { version: 7 } });
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: current.account.id, kind: "account", entityId: `session-follow-receiver:${manager.id}` } } }))
            .toEqual(receiverCursor);
        expect(await updateSessionMetadataEnvelopeTuple({ ...patch, actorUserId: current.account.id, sessionId: current.session.id,
            sharedMetadata: { ...patch.sharedMetadata, expectedVersion: 1 },
            agentState: { ciphertext: JSON.stringify({ requests: {} }), expectedVersion: 7 } }))
            .toMatchObject({ ok: true, agentState: { version: 8 } });
        expect(await admit(), "a genuine request change retains the exact final fence").toBeNull();
    });

    it("publishes cold layout-1 question and permission attention, preserves it on metadata-only edits, and clears it on settlement", async () => {
        const current = await seed();
        expect((await current.readViewer())?.attention.needsAttention).toBe(false);
        const pendingPatch = { ...current.ownerPatch(0), activitySummaryV1: pendingSummary };
        expect(await updateSessionMetadataEnvelopeTuple(pendingPatch)).toMatchObject({ ok: true,
            recipientCursors: expect.arrayContaining([expect.objectContaining({ accountId: current.account.id })]),
        });
        expect(await current.readSummary()).toEqual({
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestObservedAt: new Date(100),
        });
        const pendingViewer = await current.readViewer();
        expect(pendingViewer?.attention).toMatchObject({ needsAttention: true, presentation: "full" });
        expect(pendingViewer?.attention.reasons).toEqual(expect.arrayContaining(["permission_required", "user_action_required"]));

        expect(await updateSessionMetadataEnvelopeTuple(pendingPatch)).toMatchObject({ ok: true });
        expect(await updateSessionMetadataEnvelopeTuple(current.ownerPatch(1, 0))).toMatchObject({ ok: true });
        expect(await current.readSummary()).toMatchObject({ pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1 });

        expect(await updateSessionMetadataEnvelopeTuple({ ...current.ownerPatch(2, 0), activitySummaryV1: settledSummary }))
            .toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null });
        expect((await current.readViewer())?.attention.needsAttention).toBe(false);
    });

    it("keeps an equal legacy Agent-state refresh silent while a real request change reaches the viewer", async () => {
        const current = await seed(0);
        const write = (ciphertext: string, expectedVersion: number) => updateSessionAgentState({
            actorUserId: current.account.id, sessionId: current.session.id,
            agentStateCiphertext: ciphertext, expectedVersion,
        });
        expect(await write("{}", 0)).toMatchObject({ ok: true, version: 0, recipientCursors: [] });
        const changed = JSON.stringify({ requests: { question: { kind: "user_action", createdAt: 100 } } });
        expect(await updateSessionAgentState({ actorUserId: current.account.id, sessionId: current.session.id,
            agentStateCiphertext: changed, expectedVersion: 0, ...pendingSummary }))
            .toMatchObject({ ok: true, version: 1,
                recipientCursors: expect.arrayContaining([expect.objectContaining({ accountId: current.account.id })]) });
        expect((await current.readViewer())?.attention.needsAttention).toBe(true);
        const cursor = await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: current.account.id, kind: "session", entityId: current.session.id } } });
        expect(await write(changed, 1)).toMatchObject({ ok: true, version: 1, recipientCursors: [] });
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: current.account.id, kind: "session", entityId: current.session.id } } })).toEqual(cursor);
    });

    it("preserves legacy normalization and omitted-count semantics through the shared writer helper", async () => {
        const current = await seed(0);
        const write = (expectedVersion: number) => ({ actorUserId: current.account.id, sessionId: current.session.id,
            expectedVersion, agentStateCiphertext: JSON.stringify({ revision: expectedVersion + 1 }) });
        expect(await updateSessionAgentState({ ...write(0),
            pendingPermissionRequestCount: 1.9, pendingUserActionRequestCount: 2.8, pendingRequestNewestCreatedAt: 100.9,
        })).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 2, pendingRequestObservedAt: new Date(100),
        });
        expect(await updateSessionAgentState(write(1))).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 2, pendingRequestObservedAt: new Date(100),
        });
        expect(await updateSessionAgentState({ ...write(2), ...settledSummary })).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null,
        });
    });

    it("publishes the pending summary atomically with an owner layout migration", async () => {
        const current = await seed(0);
        const owner = createSessionOwnerMetadataV1({ metadata: {} });
        expect(owner.ok).toBe(true);
        if (!owner.ok) return;
        const patch = {
            mode: "owner_migration" as const, actorUserId: current.account.id, sessionId: current.session.id,
            expectedAccountEncryptionMode: "plain" as const, expectedAccountContentPublicKeyFingerprint: null,
            source: { metadataLayoutVersion: 0 as const, metadata: { version: 0, ciphertext: "{}" }, ownerMetadata: null,
                agentState: { version: 0, ciphertext: "{}" } },
            target: { metadataLayoutVersion: 1 as const,
                sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {}, agentState: {} })) },
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: { ciphertext: "{}" } },
            activitySummaryV1: pendingSummary,
        };
        expect(await updateSessionMetadataEnvelopeTuple(patch)).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({ pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestObservedAt: new Date(100) });
        expect((await current.readViewer())?.attention.reasons).toEqual(expect.arrayContaining(["permission_required", "user_action_required"]));
    });

    it.each([0, 1])("preserves background requests after foreground completion (layout %s)", async (layout) => {
        const current = await seed(layout);
        const turnId = randomUUID();
        const backgroundState = JSON.stringify({ requests: {
            background: { tool: "Bash", arguments: {}, createdAt: 100, sidechainId: "background-agent" },
            question: { tool: "AskUserQuestion", arguments: {}, kind: "user_action", createdAt: 100, sidechainId: "background-agent" },
        } });
        const write = (version: number, summary: typeof pendingSummary | typeof settledSummary) => {
            const ciphertext = summary === settledSummary ? "{}" : backgroundState;
            return layout === 0
                ? updateSessionAgentState({ actorUserId: current.account.id, sessionId: current.session.id,
                    expectedVersion: version === 2 ? 1 : version, agentStateCiphertext: ciphertext, ...summary })
                : updateSessionMetadataEnvelopeTuple({ ...current.ownerPatch(version),
                    agentState: { ciphertext, expectedVersion: version === 2 ? 1 : version }, activitySummaryV1: summary });
        };
        expect(await applySessionTurnMutation({ actorUserId: current.account.id, authentication,
            mutation: { v: 1, sessionId: current.session.id, turnId, action: "begin", mutationId: randomUUID(), observedAt: 50,
                initiator: "user", workDepth: 0 } })).toMatchObject({ ok: true, didApply: true });
        expect(await write(0, pendingSummary)).toMatchObject({ ok: true });
        expect(await applySessionTurnMutation({ actorUserId: current.account.id, authentication,
            mutation: { v: 1, sessionId: current.session.id, turnId, action: "complete", mutationId: randomUUID(), observedAt: 200 } }))
            .toMatchObject({ ok: true, didApply: true });
        expect(await current.readSummary()).toEqual({
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestObservedAt: new Date(100),
        });
        // Foreground turn status does not own the session-wide request summary.
        expect(await write(1, pendingSummary)).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestObservedAt: new Date(100),
        });
        expect((await current.readViewer())?.attention.reasons).toEqual(expect.arrayContaining(["permission_required", "user_action_required"]));
        expect(await write(2, settledSummary)).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null });
    });

    it("accepts authoritative pending requests while the foreground turn is terminal", async () => {
        const current = await seed();
        const turnId = randomUUID();
        expect(await applySessionTurnMutation({ actorUserId: current.account.id, authentication,
            mutation: { v: 1, sessionId: current.session.id, turnId, action: "begin", mutationId: randomUUID(), observedAt: 50,
                initiator: "user", workDepth: 0 } }))
            .toMatchObject({ ok: true, didApply: true });
        expect(await updateSessionMetadataEnvelopeTuple({ ...current.ownerPatch(0), activitySummaryV1: pendingSummary })).toMatchObject({ ok: true });
        expect(await current.readSummary()).toMatchObject({ pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1 });
        expect(await applySessionTurnMutation({ actorUserId: current.account.id, authentication,
            mutation: { v: 1, sessionId: current.session.id, turnId, action: "complete", mutationId: randomUUID(), observedAt: 200 } }))
            .toMatchObject({ ok: true, didApply: true });
        expect(await updateSessionMetadataEnvelopeTuple({ ...current.ownerPatch(1, 0), activitySummaryV1: pendingSummary })).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({ pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestObservedAt: new Date(100) });
        expect((await current.readViewer())?.attention.reasons).toEqual(expect.arrayContaining(["permission_required", "user_action_required"]));
    });
});
