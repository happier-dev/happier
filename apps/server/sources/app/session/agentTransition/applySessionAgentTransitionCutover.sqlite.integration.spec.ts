import { randomUUID } from "node:crypto";

import {
    buildSessionAgentTransitionDividerLocalId,
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
} from "@happier-dev/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applySessionAgentTransitionCutover } from "@/app/session/agentTransition/applySessionAgentTransitionCutover";
import { commitSessionAgentCurrentViewInTx } from "@/app/session/agentTransition/commitSessionAgentCurrentView";
import {
    createSessionMessage,
    patchSessionInTx,
} from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

/**
 * Lets the archive route win the one window the transition owner's own pre-read
 * cannot close.
 *
 * `commitSessionAgentCurrentViewInTx` reads the archive state together with the
 * stored current view, and only then writes through a layout CAS owner. This
 * commits the archive immediately after that pre-read returns an UNARCHIVED row,
 * so the `:261` fast path passes and only the `requireUnarchivedSession`
 * predicate threaded into the CAS write can still refuse. Two writers cannot be
 * interleaved at that instant from outside a single transaction, which is why
 * the concurrent write is injected at the database boundary; the owner, both
 * layout writers, the transaction and the database are all real.
 *
 * `raced()` reports whether the interleaving actually happened. Every caller
 * asserts it, so an owner that stops issuing the pre-read fails loudly instead
 * of passing through the archived fast path.
 */
function archiveAfterCurrentViewPreRead(tx: Tx, sessionId: string) {
    let raced = false;
    const session = new Proxy(tx.session, {
        get(target, property) {
            if (property !== "findUnique") {
                const value: unknown = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
            }
            return async (args: never) => {
                const row: unknown = await target.findUnique(args);
                const isCurrentViewPreRead = !raced
                    && row !== null
                    && typeof row === "object"
                    && "archivedAt" in row
                    && "agentStateVersion" in row;
                if (isCurrentViewPreRead) {
                    raced = true;
                    await tx.session.update({
                        where: { id: sessionId },
                        data: { archivedAt: new Date(1_700_000_000_000) },
                    });
                }
                return row;
            };
        },
    });
    const proxied = new Proxy(tx, {
        get(target, property) {
            if (property === "session") return session;
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return { tx: proxied, raced: () => raced };
}

const STORED_PLAIN_OWNER_METADATA_ENVELOPE = JSON.stringify(
    createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 }),
);
const STORED_SHARED_METADATA = JSON.stringify(
    projectSessionSharedMetadataV1({ metadata: {} }),
);

function dividerContent(params: Readonly<{
    fromAgentId: string;
    toAgentId: string;
    id?: string;
    sourceCutoffSeqInclusive?: number;
    returningAgentLastSeenSeqInclusive?: number;
}>) {
    return {
        t: "plain" as const,
        v: {
            role: "agent",
            content: {
                type: "event",
                // Required by the agent-event record schema. Deterministic so a
                // retry re-derives byte-identical divider content.
                id: params.id ?? "agent-transition-divider",
                data: {
                    type: "message",
                    message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
                    sessionAgentTransitionV1: {
                        v: 1,
                        fromAgentId: params.fromAgentId,
                        toAgentId: params.toAgentId,
                        sourceCutoffSeqInclusive: params.sourceCutoffSeqInclusive ?? 29_979,
                        ...(params.returningAgentLastSeenSeqInclusive === undefined
                            ? {}
                            : { returningAgentLastSeenSeqInclusive: params.returningAgentLastSeenSeqInclusive }),
                    },
                },
            },
        },
    };
}

async function createOwner() {
    return await db.account.create({
        data: { publicKey: `agent-transition-${randomUUID()}`, encryptionMode: "plain" },
        select: { id: true },
    });
}

async function createLayoutZeroSession(accountId: string, overrides?: Readonly<{
    active?: boolean;
    archivedAt?: Date | null;
}>) {
    return await db.session.create({
        data: {
            tag: `agent-transition-${randomUUID()}`,
            accountId,
            encryptionMode: "plain",
            metadata: JSON.stringify({ flavor: "claude", claudeSessionId: "src-1" }),
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            currentStorageState: "hosted",
            active: overrides?.active ?? false,
            ...(overrides?.archivedAt ? { archivedAt: overrides.archivedAt } : {}),
            // A valid non-baseline projection: revision zero is reserved for the
            // exact unknown baseline, so a clear from it would be a no-op.
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: BigInt(1_700_000_000_000),
            runtimeActivityRevision: BigInt(1),
        },
        select: {
            id: true,
            tag: true,
            accountId: true,
            metadataVersion: true,
            agentStateVersion: true,
            archivedAt: true,
        },
    });
}

async function createLayoutOneSession(accountId: string) {
    return await db.session.create({
        data: {
            tag: `agent-transition-l1-${randomUUID()}`,
            accountId,
            encryptionMode: "plain",
            metadata: STORED_SHARED_METADATA,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_PLAIN_OWNER_METADATA_ENVELOPE,
            currentStorageState: "hosted",
            active: false,
        },
        select: { id: true, metadataVersion: true, agentStateVersion: true },
    });
}

describe("applySessionAgentTransitionCutover (sqlite)", () => {
    let harness: LightSqliteHarness;
    let previousStoragePolicy: string | undefined;

    beforeAll(async () => {
        previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-agent-transition-cutover-",
            initAuth: false,
        });
    }, 180_000);

    afterAll(async () => {
        if (previousStoragePolicy === undefined) {
            delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        } else {
            process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
        }
        await harness.close();
    });

    it("commits the target current view, clears the runtime projection, then appends exactly one divider", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.dividerWrite?.didWrite).toBe(true);
        expect(result.currentView.currentView).toMatchObject({ kind: "legacy_v0" });

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                tag: true,
                accountId: true,
                archivedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
            },
        });
        // Session identity and archive state are carried, not touched.
        expect(after.tag).toBe(session.tag);
        expect(after.accountId).toBe(session.accountId);
        expect(after.archivedAt).toBeNull();
        // Target current view committed; AgentState cleared for the target to republish.
        expect(JSON.parse(after.metadata as string)).toEqual({ flavor: "codex" });
        expect(after.metadataVersion).toBe(session.metadataVersion + 1);
        expect(after.agentState).toBeNull();
        // Runtime activity cleared through the canonical helper, in the same transaction.
        expect(after.runtimeActivityState).toBe("unknown");
        expect(after.runtimeActivityActiveCount).toBe(0);

        const dividers = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { seq: true, localId: true, messageRole: true },
        });
        expect(dividers).toHaveLength(1);
        expect(dividers[0]).toMatchObject({ localId, messageRole: "event", seq: result.dividerSeq });
    }, 60_000);

    it("carries no user attention and does not move the read projection", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { lastViewedSessionSeq: true, latestReadyEventSeq: true, meaningfulActivityAt: true },
        });
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const write = result.dividerWrite;
        expect(write?.didWrite).toBe(true);
        if (!write?.didWrite) return;
        expect(write.attentionImpact).toEqual({
            affectsUnread: false,
            affectsMeaningfulActivity: false,
        });
        expect(write.badgeAttentionChanged).toBe(false);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { latestReadyEventSeq: true, meaningfulActivityAt: true, lastViewedSessionSeq: true },
        });
        expect(after.latestReadyEventSeq).toBe(before.latestReadyEventSeq);
        expect(after.meaningfulActivityAt?.getTime() ?? null)
            .toBe(before.meaningfulActivityAt?.getTime() ?? null);
        // The owner advances the read cursor past a non-unread row, which is how
        // the divider leaves unread at zero instead of creating a phantom unread.
        expect(after.lastViewedSessionSeq).toBe(result.dividerSeq);
    }, 60_000);

    it("returns the existing sequence for an identical re-append and writes nothing new", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);
        const content = dividerContent({ fromAgentId: "claude", toAgentId: "codex" });
        const currentView = {
            kind: "legacy_v0" as const,
            expectedMetadataVersion: session.metadataVersion,
            metadataCiphertext: JSON.stringify({ flavor: "codex" }),
            expectedAgentStateVersion: session.agentStateVersion,
            agentStateCiphertext: null,
        };

        const first = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView,
            divider: { localId, content },
        });
        expect(first.ok).toBe(true);

        // A lost response can reconcile even after the target has been activated:
        // the exact-current-view retry check runs before the inactive precondition.
        await db.session.update({ where: { id: session.id }, data: { active: true } });

        // Exactly the same request again — including the now-stale expected
        // versions. An exact already-committed target tuple is an idempotent
        // success, and the divider returns its existing sequence.
        const retry = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView,
            divider: { localId, content },
        });

        expect(retry).toMatchObject({ ok: true });
        if (!retry.ok || !first.ok) return;
        expect(retry.dividerSeq).toBe(first.dividerSeq);
        expect(retry.dividerWrite).toBeNull();

        const rows = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { seq: true, rowRevision: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.rowRevision).toBe(BigInt(0));
    }, 60_000);

    it("clears the retired runtime's request and thinking projections", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        // A source runtime that died holding requests leaves these behind. They
        // describe a process that no longer exists, so they must not survive the
        // cutover and keep a permission badge lit against the NEW Agent.
        await db.session.update({
            where: { id: session.id },
            data: {
                thinking: true,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: new Date(1_700_000_000_000),
            },
        });
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });
        expect(result.ok).toBe(true);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                thinking: true,
                pendingPermissionRequestCount: true,
                pendingUserActionRequestCount: true,
                pendingRequestObservedAt: true,
            },
        });
        expect(after).toEqual({
            thinking: false,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
        });
    }, 60_000);

    it("returns a layout-one exact replay as an idempotent success", async () => {
        const owner = await createOwner();
        const session = await createLayoutOneSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);
        const content = dividerContent({ fromAgentId: "claude", toAgentId: "codex" });
        const nextShared = JSON.stringify(
            projectSessionSharedMetadataV1({ metadata: { flavor: "codex" } }),
        );
        const currentView = {
            kind: "envelope_tuple_v1" as const,
            ownerPatch: {
                mode: "owner_inactive_model_intent" as const,
                metadataLayoutVersion: 1 as const,
                expectedOwnerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 }),
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({
                    v: 1,
                    runtime: { permissionMode: "default" },
                }),
                sharedMetadata: {
                    ciphertext: nextShared,
                    expectedVersion: session.metadataVersion,
                },
                agentState: { ciphertext: null, expectedVersion: session.agentStateVersion },
                sessionExpectation: { kind: "inactive_model_intent" as const },
            },
        };

        const first = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView,
            divider: { localId, content },
        });
        expect(first.ok).toBe(true);

        // `AM-14(b)` requires the exact-retry check at this owner for BOTH
        // layouts, not only layout zero, and the package rule is that a
        // retryable operation produces the same durable result as one call.
        await db.session.update({ where: { id: session.id }, data: { active: true } });
        const retry = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView,
            divider: { localId, content },
        });

        expect(retry).toMatchObject({ ok: true });
        if (!retry.ok || !first.ok) return;
        expect(retry.dividerSeq).toBe(first.dividerSeq);
        expect(retry.dividerWrite).toBeNull();
        // Nothing was committed a second time, so there is nothing to announce.
        expect(retry.currentView.publication).toBeNull();
        expect(retry.currentView.participantCursors).toEqual([]);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true },
        });
        expect(after.metadataVersion).toBe(session.metadataVersion + 1);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
    }, 60_000);

    it("leaves the started target's live Activity alone on an exact retry", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);
        const content = dividerContent({ fromAgentId: "claude", toAgentId: "codex" });
        const currentView = {
            kind: "legacy_v0" as const,
            expectedMetadataVersion: session.metadataVersion,
            metadataCiphertext: JSON.stringify({ flavor: "codex" }),
            expectedAgentStateVersion: session.agentStateVersion,
            agentStateCiphertext: null,
        };

        const first = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView,
            divider: { localId, content },
        });
        expect(first.ok).toBe(true);

        // The exact state PLAN §6.6 says the retry check exists to serve: the
        // response was lost, the target has since STARTED, and it is publishing
        // live Activity through the canonical projection owner.
        await db.session.update({
            where: { id: session.id },
            data: {
                active: true,
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_700_000_000_001),
                runtimeActivityRevision: BigInt(5),
            },
        });

        const retry = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView,
            divider: { localId, content },
        });
        expect(retry.ok).toBe(true);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        });
        // Replaying an already-committed cutover must not reach back into the
        // NEW runtime's state. The clear belongs to the commit that already
        // happened in one transaction with it; repeating it here would blank a
        // working target until its next Activity transition.
        expect(after.runtimeActivityState).toBe("active");
        expect(after.runtimeActivityActiveCount).toBe(2);
        expect(after.runtimeActivityRevision).toBe(BigInt(5));
    }, 60_000);

    it("refuses to overwrite a different transition payload at the reserved localId", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);
        const stale = dividerContent({ fromAgentId: "gemini", toAgentId: "claude" });

        const seeded = await createSessionMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: stale,
            messageRole: "event",
        });
        expect(seeded.ok).toBe(true);

        const fresh = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, agentStateVersion: true },
        });
        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: fresh.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: fresh.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        // The current view IS committed, so this can never ride `rejected`.
        expect(result).toMatchObject({
            ok: false,
            effect: "current_view_committed",
            error: "divider-conflict",
        });
        // ...and the committed view travels WITH the failure, so the caller can
        // announce the Agent change that really happened instead of leaving
        // every other client on the old Agent until a change-cursor catch-up.
        expect(result).toHaveProperty("currentView.publication.kind", "legacy_v0");
        expect((result as { currentView: { participantCursors: unknown[] } }).currentView.participantCursors)
            .not.toHaveLength(0);

        const rows = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { content: true },
        });
        expect(rows).toHaveLength(1);
        // The pre-existing row was NOT overwritten in place.
        expect(rows[0]?.content).toEqual(stale);
    }, 60_000);

    it("refuses a same-Agent divider whose replay bounds differ", async () => {
        for (const [label, stale] of [
            [
                "source cutoff",
                dividerContent({
                    fromAgentId: "claude",
                    toAgentId: "codex",
                    sourceCutoffSeqInclusive: 29_978,
                }),
            ],
            [
                "native-return lower bound",
                dividerContent({
                    fromAgentId: "claude",
                    toAgentId: "codex",
                    sourceCutoffSeqInclusive: 29_979,
                    returningAgentLastSeenSeqInclusive: 130,
                }),
            ],
        ] as const) {
            const owner = await createOwner();
            const session = await createLayoutZeroSession(owner.id);
            const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);
            const seeded = await createSessionMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                content: stale,
                messageRole: "event",
            });
            expect(seeded.ok, label).toBe(true);

            const fresh = await db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { metadataVersion: true, agentStateVersion: true },
            });
            const result = await applySessionAgentTransitionCutover({
                actorUserId: owner.id,
                sessionId: session.id,
                currentView: {
                    kind: "legacy_v0",
                    expectedMetadataVersion: fresh.metadataVersion,
                    metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                    expectedAgentStateVersion: fresh.agentStateVersion,
                    agentStateCiphertext: null,
                },
                divider: {
                    localId,
                    content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }),
                },
            });

            expect(result, label).toMatchObject({
                ok: false,
                effect: "current_view_committed",
                error: "divider-conflict",
            });
            const rows = await db.sessionMessage.findMany({
                where: { sessionId: session.id },
                select: { content: true },
            });
            expect(rows, label).toHaveLength(1);
            expect(rows[0]?.content, label).toEqual(stale);
        }
    }, 60_000);

    /**
     * The E2EE half of the same reserved-namespace attack.
     *
     * For an E2EE Session the stored divider is opaque ciphertext, so the server
     * cannot tell this operation's own retry from a row somebody else planted —
     * re-sealing the same payload yields different bytes, so comparing ciphertext
     * would report a false conflict on every legitimate retry. The server must
     * therefore not silently classify an existing opaque row as "same operation"
     * and let activation proceed on it. It reports a distinguishable outcome and
     * defers the decision to the daemon, which owns the key.
     */
    it("flags an existing opaque divider row for daemon verification instead of trusting it", async () => {
        const owner = await db.account.create({
            data: { publicKey: `agent-transition-e2ee-${randomUUID()}`, encryptionMode: "e2ee" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `agent-transition-e2ee-${randomUUID()}`,
                accountId: owner.id,
                encryptionMode: "e2ee",
                metadata: "c291cmNlLW1ldGFkYXRh",
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                currentStorageState: "hosted",
                active: false,
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(1_700_000_000_000),
                runtimeActivityRevision: BigInt(1),
            },
            select: { id: true, metadataVersion: true, agentStateVersion: true },
        });
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        // A row the server cannot read, sitting at the reserved localId.
        const planted = await createSessionMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: { t: "encrypted", c: "cGxhbnRlZC1vcGFxdWUtZGl2aWRlcg==" },
            messageRole: "event",
        });
        expect(planted.ok).toBe(true);

        const fresh = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, agentStateVersion: true },
        });
        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: fresh.metadataVersion,
                metadataCiphertext: "dGFyZ2V0LW1ldGFkYXRh",
                expectedAgentStateVersion: fresh.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: { t: "encrypted", c: "Y2FuZGlkYXRlLWRpdmlkZXI=" } },
        });

        expect(result).toMatchObject({ ok: true, dividerVerificationRequired: true });
        if (!result.ok) return;
        // Still never overwritten, and still no second sequence.
        expect(result.dividerWrite).toBeNull();
        const rows = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { seq: true, content: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.content).toEqual({ t: "encrypted", c: "cGxhbnRlZC1vcGFxdWUtZGl2aWRlcg==" });
        expect(result.dividerSeq).toBe(rows[0]?.seq);
    }, 60_000);

    it("does not ask for daemon verification when it wrote the divider itself", async () => {
        const owner = await db.account.create({
            data: { publicKey: `agent-transition-e2ee-${randomUUID()}`, encryptionMode: "e2ee" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `agent-transition-e2ee-${randomUUID()}`,
                accountId: owner.id,
                encryptionMode: "e2ee",
                metadata: "c291cmNlLW1ldGFkYXRh",
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                currentStorageState: "hosted",
                active: false,
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(1_700_000_000_000),
                runtimeActivityRevision: BigInt(1),
            },
            select: { id: true, metadataVersion: true, agentStateVersion: true },
        });
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: "dGFyZ2V0LW1ldGFkYXRh",
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: { t: "encrypted", c: "Y2FuZGlkYXRlLWRpdmlkZXI=" } },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.dividerVerificationRequired).toBeUndefined();
        expect(result.dividerWrite?.didWrite).toBe(true);
    }, 60_000);

    it("refuses a non-owner actor before any effect", async () => {
        const owner = await createOwner();
        const stranger = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: stranger.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "forbidden" });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
    }, 60_000);

    it("rejects an active Session with effect none and writes nothing", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id, { active: true });
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "session-active" });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, runtimeActivityState: true },
        });
        expect(after.metadataVersion).toBe(session.metadataVersion);
        expect(after.runtimeActivityState).toBe("active");
    }, 60_000);

    it("rejects an archived Session with effect none", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id, { archivedAt: new Date(1_700_000_000_000) });
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "archived" });
        // `effect: none` is only truthful if the archive really wins everything:
        // no metadata, no runtime projection, no participant cursor, no divider.
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadata: true,
                metadataVersion: true,
                agentStateVersion: true,
                runtimeActivityState: true,
                runtimeActivityRevision: true,
            },
        });
        expect(after.metadataVersion).toBe(session.metadataVersion);
        expect(after.agentStateVersion).toBe(session.agentStateVersion);
        expect(after.metadata).toBe(JSON.stringify({ flavor: "claude", claudeSessionId: "src-1" }));
        expect(after.runtimeActivityState).toBe("active");
        expect(after.runtimeActivityRevision).toBe(BigInt(1));
        expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(0);
    }, 60_000);

    /**
     * The archive/transition interleaving the owner's pre-read cannot close.
     *
     * `commitSessionAgentCurrentView` reads `archivedAt` and then writes through
     * one of two shipped layout CAS owners. An archive committing between that
     * read and the write used to be invisible to both predicates, so archive and
     * transition could both commit and unarchiving would reveal a silently
     * changed current Agent.
     *
     * These two drive the TRANSITION OWNER, not the layout writers, because the
     * predicate is opt-in: a version of this owner that simply stops asking for
     * `requireUnarchivedSession` is a plausible implementation, and only a test
     * that routes through the owner can see it. The layout writers honouring the
     * flag when it IS passed is proven by the same run, one frame lower.
     */
    it("refuses the layout-zero current-view CAS when an archive lands after the pre-read", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);

        const race = await inTx(async (tx) => {
            const interleaved = archiveAfterCurrentViewPreRead(tx, session.id);
            const result = await commitSessionAgentCurrentViewInTx(interleaved.tx, {
                actorUserId: owner.id,
                sessionId: session.id,
                currentView: {
                    kind: "legacy_v0",
                    expectedMetadataVersion: session.metadataVersion,
                    metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                    expectedAgentStateVersion: session.agentStateVersion,
                    agentStateCiphertext: null,
                },
            });
            return { result, raced: interleaved.raced() };
        });

        // The pre-read really did pass before the archive committed, so this is
        // the CAS refusing and not the `:261` fast path.
        expect(race.raced).toBe(true);
        expect(race.result).toEqual({ ok: false, error: "archived" });
        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadata: true,
                metadataVersion: true,
                agentStateVersion: true,
                archivedAt: true,
                runtimeActivityState: true,
                runtimeActivityRevision: true,
            },
        });
        expect(after.archivedAt).not.toBeNull();
        expect(after.metadataVersion).toBe(session.metadataVersion);
        expect(after.agentStateVersion).toBe(session.agentStateVersion);
        expect(after.metadata).toBe(JSON.stringify({ flavor: "claude", claudeSessionId: "src-1" }));
        // Nothing in the transaction ran past the refused write.
        expect(after.runtimeActivityState).toBe("active");
        expect(after.runtimeActivityRevision).toBe(BigInt(1));
    }, 60_000);

    it("refuses the layout-one current-view CAS when an archive lands after the pre-read", async () => {
        const owner = await createOwner();
        const session = await createLayoutOneSession(owner.id);
        const nextShared = JSON.stringify(
            projectSessionSharedMetadataV1({ metadata: { flavor: "codex" } }),
        );

        const race = await inTx(async (tx) => {
            const interleaved = archiveAfterCurrentViewPreRead(tx, session.id);
            const result = await commitSessionAgentCurrentViewInTx(interleaved.tx, {
                actorUserId: owner.id,
                sessionId: session.id,
                currentView: {
                    kind: "envelope_tuple_v1",
                    ownerPatch: {
                        mode: "owner_inactive_model_intent",
                        metadataLayoutVersion: 1,
                        expectedOwnerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 }),
                        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({
                            v: 1,
                            runtime: { permissionMode: "default" },
                        }),
                        sharedMetadata: {
                            ciphertext: nextShared,
                            expectedVersion: session.metadataVersion,
                        },
                        agentState: { ciphertext: null, expectedVersion: session.agentStateVersion },
                        sessionExpectation: { kind: "inactive_model_intent" },
                    },
                },
            });
            return { result, raced: interleaved.raced() };
        });

        expect(race.raced).toBe(true);
        expect(race.result).toEqual({ ok: false, error: "archived" });
        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadata: true,
                metadataVersion: true,
                agentStateVersion: true,
                ownerMetadata: true,
                archivedAt: true,
            },
        });
        expect(after.archivedAt).not.toBeNull();
        expect(after.metadataVersion).toBe(session.metadataVersion);
        expect(after.agentStateVersion).toBe(session.agentStateVersion);
        expect(after.metadata).toBe(STORED_SHARED_METADATA);
        expect(after.ownerMetadata).toBe(STORED_PLAIN_OWNER_METADATA_ENVELOPE);
    }, 60_000);

    it("leaves every other inactive-model-intent writer free to patch an archived Session", async () => {
        // The predicate is opt-in on purpose. `setSessionModel` and the ordinary
        // Action executor use the same `inactive_model_intent` expectation and
        // must keep working on an archived Session; only the transition asks for
        // the stricter precondition.
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id, {
            archivedAt: new Date(1_700_000_000_000),
        });

        const result = await inTx(async (tx) => await patchSessionInTx(tx, {
            actorUserId: owner.id,
            sessionId: session.id,
            metadata: {
                ciphertext: JSON.stringify({ flavor: "claude", claudeSessionId: "src-2" }),
                expectedVersion: session.metadataVersion,
            },
            sessionExpectation: { kind: "inactive_model_intent" },
        }));

        expect(result.ok).toBe(true);
        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true },
        });
        expect(after.metadataVersion).toBe(session.metadataVersion + 1);
    }, 60_000);

    it("returns effect none on a metadata version CAS loss and appends no divider", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion + 7,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "version-mismatch" });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
    }, 60_000);

    it("refuses a divider localId outside the reserved namespace before touching the current view", async () => {
        const owner = await createOwner();
        const session = await createLayoutZeroSession(owner.id);

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "legacy_v0",
                expectedMetadataVersion: session.metadataVersion,
                metadataCiphertext: JSON.stringify({ flavor: "codex" }),
                expectedAgentStateVersion: session.agentStateVersion,
                agentStateCiphertext: null,
            },
            divider: {
                localId: "ordinary-local-id",
                content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }),
            },
        });

        expect(result).toEqual({ ok: false, effect: "none", error: "invalid-params" });
        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true },
        });
        expect(after.metadataVersion).toBe(session.metadataVersion);
    }, 60_000);

    it("commits a layout-one current view through the shipped inactive-model-intent precondition", async () => {
        const owner = await createOwner();
        const session = await createLayoutOneSession(owner.id);
        const localId = buildSessionAgentTransitionDividerLocalId(`submitted-${randomUUID()}`);
        const nextShared = JSON.stringify(
            projectSessionSharedMetadataV1({ metadata: { flavor: "codex" } }),
        );

        const result = await applySessionAgentTransitionCutover({
            actorUserId: owner.id,
            sessionId: session.id,
            currentView: {
                kind: "envelope_tuple_v1",
                ownerPatch: {
                    mode: "owner_inactive_model_intent",
                    metadataLayoutVersion: 1,
                    expectedOwnerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 }),
                    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({
                        v: 1,
                        runtime: { permissionMode: "default" },
                    }),
                    sharedMetadata: {
                        ciphertext: nextShared,
                        expectedVersion: session.metadataVersion,
                    },
                    agentState: { ciphertext: null, expectedVersion: session.agentStateVersion },
                    sessionExpectation: { kind: "inactive_model_intent" },
                },
            },
            divider: { localId, content: dividerContent({ fromAgentId: "claude", toAgentId: "codex" }) },
        });

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.currentView.currentView).toMatchObject({ kind: "envelope_tuple_v1" });
        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, runtimeActivityState: true },
        });
        expect(after.metadataVersion).toBe(session.metadataVersion + 1);
        expect(after.runtimeActivityState).toBe("unknown");
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
    }, 60_000);
});
