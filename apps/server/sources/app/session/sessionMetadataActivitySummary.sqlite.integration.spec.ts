import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    encodeSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "./access/sessionAccessAuthentication.testkit";
import { loadSessionViewerProjection } from "./personal/projection";
import { applySessionTurnMutation, updateSessionAgentState, updateSessionMetadataEnvelopeTuple } from "./sessionWriteService";

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
        const ownerPatch = (expectedVersion: number) => ({
            mode: "owner" as const, actorUserId: account.id, sessionId: session.id, metadataLayoutVersion: 1 as const,
            expectedOwnerMetadata: ownerEnvelope, ownerMetadata: ownerEnvelope,
            sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }), expectedVersion },
            agentState: { ciphertext: "{}", expectedVersion },
        });
        return { account, session, readSummary, readViewer, ownerPatch };
    }

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
        expect(await updateSessionMetadataEnvelopeTuple(current.ownerPatch(1))).toMatchObject({ ok: true });
        expect(await current.readSummary()).toMatchObject({ pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1 });

        expect(await updateSessionMetadataEnvelopeTuple({ ...current.ownerPatch(2), activitySummaryV1: settledSummary }))
            .toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null });
        expect((await current.readViewer())?.attention.needsAttention).toBe(false);
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

    it("does not relight terminal-turn attention from a delayed tuple summary", async () => {
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
        expect(await updateSessionMetadataEnvelopeTuple({ ...current.ownerPatch(1), activitySummaryV1: pendingSummary })).toMatchObject({ ok: true });
        expect(await current.readSummary()).toEqual({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null });
        expect((await current.readViewer())?.attention.reasons).not.toEqual(expect.arrayContaining(["permission_required", "user_action_required"]));
    });
});
