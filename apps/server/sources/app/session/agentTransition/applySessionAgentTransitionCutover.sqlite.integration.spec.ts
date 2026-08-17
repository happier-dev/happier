import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
    SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
    buildSessionAgentTransitionDividerLocalId,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { applySessionAgentTransitionCutover } from "./applySessionAgentTransitionCutover";

/**
 * The Agent-transition cutover against a real database.
 *
 * These are the assertions that a mocked prisma cannot make: that the current
 * view and the divider land in the stated ORDER, that the inactive/unarchived
 * preconditions are enforced by the write itself and not only by a prior read,
 * that a re-issued divider reconciles to the same sequence instead of appending
 * a second boundary, and — the one most likely to regress silently — that the
 * divider moves no unread or ready-event projection.
 */
describe("applySessionAgentTransitionCutover on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-agent-transition-cutover-sqlite-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    const SUBMITTED_LOCAL_ID = "local-42";
    const dividerLocalId = buildSessionAgentTransitionDividerLocalId(SUBMITTED_LOCAL_ID);

    /**
     * The Session is E2EE, which is the default storage policy, so the divider
     * arrives already sealed and the server cannot read it. That is deliberate:
     * it is exactly the case where the write-time `trustedAttentionImpact` is
     * the only thing keeping the divider out of unread, and where a
     * content-derived rule would silently not apply. The daemon derives the
     * ciphertext deterministically from the divider localId, so a retry
     * produces the identical string and the message owner reconciles it.
     */
    function dividerContent(toAgentId: string): PrismaJson.SessionMessageContent {
        return {
            t: "encrypted",
            c: `divider-cipher:${dividerLocalId}:claude->${toAgentId}`,
        } as unknown as PrismaJson.SessionMessageContent;
    }

    async function seed(overrides: Record<string, unknown> = {}) {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: JSON.stringify({ flavor: "claude" }),
                active: false,
                agentState: JSON.stringify({ thinking: true }),
                thinking: true,
                pendingPermissionRequestCount: 2,
                ...overrides,
            },
            select: { id: true, metadataVersion: true, agentStateVersion: true },
        });
        return { ownerId: owner.id, ...session };
    }

    function currentView(session: { metadataVersion: number; agentStateVersion: number }, agentId = "codex") {
        return {
            kind: "legacy_v0" as const,
            expectedMetadataVersion: session.metadataVersion,
            metadataCiphertext: JSON.stringify({ flavor: agentId }),
            expectedAgentStateVersion: session.agentStateVersion,
            agentStateCiphertext: null,
        };
    }

    it("commits the sealed target view, clears the source runtime projections, and appends one divider", async () => {
        const session = await seed();

        const result = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const row = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                thinking: true,
                pendingPermissionRequestCount: true,
                pendingUserActionRequestCount: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        });
        expect(JSON.parse(row.metadata)).toEqual({ flavor: "codex" });
        expect(row.metadataVersion).toBe(session.metadataVersion + 1);
        expect(row.agentState).toBeNull();
        expect(row.agentStateVersion).toBe(session.agentStateVersion + 1);
        expect(row.thinking).toBe(false);
        expect(row.pendingPermissionRequestCount).toBe(0);
        expect(row.pendingUserActionRequestCount).toBe(0);

        const messages = await db.sessionMessage.findMany({ where: { sessionId: session.id }, select: { localId: true, seq: true } });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.localId).toBe(dividerLocalId);
        expect(result.dividerSeq).toBe(messages[0]?.seq);
    });

    it("refuses to cut over an active Session", async () => {
        const session = await seed({ active: true });

        const result = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "session-active" });
        const row = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true } });
        expect(JSON.parse(row.metadata)).toEqual({ flavor: "claude" });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    });

    it("refuses to cut over an archived Session", async () => {
        const session = await seed({ archivedAt: new Date() });

        const result = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "archived" });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    });

    it("loses the metadata version CAS without touching the Session", async () => {
        const session = await seed();

        const result = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: { ...currentView(session), expectedMetadataVersion: session.metadataVersion + 5 },
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "version-mismatch" });
        const row = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true, agentState: true } });
        expect(JSON.parse(row.metadata)).toEqual({ flavor: "claude" });
        expect(row.agentState).not.toBeNull();
    });

    it("refuses a non-owner even with an otherwise valid request", async () => {
        const session = await seed();
        const stranger = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` }, select: { id: true } });

        const result = await applySessionAgentTransitionCutover({
            actorUserId: stranger.id,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "forbidden" });
    });

    it("refuses a divider localId outside the reserved namespace before any write", async () => {
        const session = await seed();

        const result = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: "not-reserved", content: dividerContent("codex") },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "invalid-params" });
        const row = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true } });
        expect(JSON.parse(row.metadata)).toEqual({ flavor: "claude" });
    });

    it("re-appending the identical divider returns the existing sequence and writes no second row", async () => {
        const session = await seed();
        const first = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, agentStateVersion: true },
        });
        const second = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: after.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: after.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });

        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.dividerSeq).toBe(first.dividerSeq);
        expect(second.dividerDidWrite).toBe(false);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(1);
    });

    it("refuses a different transition payload at the reserved localId and keeps the committed view", async () => {
        const session = await seed();
        const first = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });
        expect(first.ok).toBe(true);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, agentStateVersion: true },
        });
        const conflicting = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: after.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "gemini" }),
                expectedAgentStateVersion: after.agentStateVersion,
                agentStateCiphertext: null,
            },
            // Same reserved localId, DIFFERENT transition payload.
            divider: { localId: dividerLocalId, content: dividerContent("gemini") },
        });

        expect(conflicting.ok).toBe(false);
        if (conflicting.ok) return;
        expect(conflicting.effect).toBe("current_view_committed");
        expect(conflicting.error).toBe("divider-conflict");

        const stored = await db.sessionMessage.findFirstOrThrow({
            where: { sessionId: session.id, localId: dividerLocalId },
            select: { content: true },
        });
        // The original boundary survives: the message owner would have
        // overwritten it in place, so the refusal has to happen above it.
        expect(JSON.stringify(stored.content)).toContain("claude->codex");
        expect(JSON.stringify(stored.content)).not.toContain("claude->gemini");
    });

    it("moves no unread, ready-event or attention projection", async () => {
        const session = await seed({ pendingPermissionRequestCount: 0 });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { seq: true, unreadSince: true, latestReadyEventSeq: true, needsAttention: true, meaningfulActivityAt: true },
        });

        const result = await applySessionAgentTransitionCutover({
            actorUserId: session.ownerId,
            sessionId: session.id,
            currentView: currentView(session),
            divider: { localId: dividerLocalId, content: dividerContent("codex") },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.attentionImpact).toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { unreadSince: true, latestReadyEventSeq: true, needsAttention: true, meaningfulActivityAt: true },
        });
        expect(after.unreadSince).toEqual(before.unreadSince);
        expect(after.latestReadyEventSeq).toEqual(before.latestReadyEventSeq);
        expect(after.needsAttention).toEqual(before.needsAttention);
        expect(after.meaningfulActivityAt).toEqual(before.meaningfulActivityAt);
    });
});
