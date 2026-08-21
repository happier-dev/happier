import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { writeSessionRuntimeActivityObserverLossInTx } from "@/app/session/runtimeActivity/writeProjection";
import {
    applySessionMetadataVersionCasInTx,
    ensureSessionOwnerAccessInTx,
} from "@/app/session/sessionWriteService";
import { inTx, type Tx } from "@/storage/inTx";

/**
 * The Agent-transition current-view commit — one narrow transaction.
 *
 * This is the predecessor (layout-zero) shape: the Session's current view is the
 * sealed `metadata` ciphertext plus its `metadataVersion`, with `agentState`
 * cleared through its own version. There is no metadata-envelope tuple and no
 * `owner_inactive_model_intent` patch mode in this tree, so the inactive
 * precondition is expressed directly in the CAS predicate instead of being
 * inherited from a shipped patch mode.
 *
 * What the transaction proves before anything is written:
 * - the actor OWNS the Session (an edit share is not enough to replace its Agent);
 * - the Session exists, is `archivedAt: null`, and is `active: false` — a stopped
 *   source is the whole point of the preceding confirmed stop;
 * - the caller's `expectedMetadataVersion` still holds.
 *
 * What it writes, all in the same `updateMany`:
 * - the sealed target metadata and its next version;
 * - `agentState: null` at `expectedAgentStateVersion + 1`, because the source
 *   Agent's published state describes a runtime that no longer exists;
 * - `thinking: false` and cleared pending-request counters, which are the
 *   source runtime's current projections rather than Session history.
 *
 * Runtime-activity is cleared through its own canonical owner in the same
 * transaction. This service deliberately writes NO divider: that is the next
 * ordered step through `createSessionMessage`, whose localId reconciliation,
 * access checks, participant cursors, badge accounting and publication a raw
 * in-transaction transcript write would bypass.
 */
export type SessionAgentTransitionCurrentViewWriteV1 = Readonly<{
    /**
     * Only one layout exists in this tree. The discriminator is kept so the
     * predecessor and successor services read the same way at their call sites,
     * and so a later layout is an added arm rather than a signature change.
     */
    kind: "legacy_v0";
    expectedMetadataVersion: number;
    metadataCiphertext: string;
    expectedAgentStateVersion: number;
    /** Always `null`: the target republishes its own AgentState after activation. */
    agentStateCiphertext: null;
}>;

export type CommitSessionAgentCurrentViewParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    currentView: SessionAgentTransitionCurrentViewWriteV1;
}>;

export type SessionAgentTransitionCommittedCurrentViewV1 = Readonly<{
    kind: "legacy_v0";
    metadataVersion: number;
    agentStateVersion: number;
}>;

export type CommitSessionAgentCurrentViewErrorV1 =
    | "invalid-params"
    | "forbidden"
    | "session-not-found"
    | "archived"
    | "session-active"
    | "version-mismatch"
    | "internal";

export type CommitSessionAgentCurrentViewResult =
    | {
        ok: true;
        currentView: SessionAgentTransitionCommittedCurrentViewV1;
        participantCursors: SessionParticipantCursor[];
        metadataCiphertext: string;
        agentStateCiphertext: null;
      }
    | { ok: false; error: CommitSessionAgentCurrentViewErrorV1 };

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * True when the stored row already IS the exact target this call would write —
 * i.e. this call replays a write that already landed.
 *
 * `apps/server/AGENTS.md` requires a retryable operation to produce the same
 * durable result as one call. Without this, a replayed cutover — the same
 * request bytes a caller re-sends after a lost response — loses the
 * `agentStateVersion` precondition and the metadata CAS, and is answered
 * `version-mismatch` with `effect: 'none'`: a promise that the Session was never
 * touched, which is false. The daemon's one-shot retry then refetches, sees the
 * Session already naming the target, and reports `cutover_conflict` for a
 * transition that fully succeeded.
 *
 * Content equality is the signal, not version arithmetic. The shared metadata
 * version must have MOVED PAST the expected one, which is what proves a write
 * already landed; an unchanged first attempt still takes the normal path and its
 * preconditions.
 */
function isExactCommittedTargetCurrentView(
    current: Readonly<{
        metadata: string | null;
        metadataVersion: number;
        agentState: string | null;
        agentStateVersion: number;
    }>,
    currentView: SessionAgentTransitionCurrentViewWriteV1,
): SessionAgentTransitionCommittedCurrentViewV1 | null {
    const matches = current.metadata === currentView.metadataCiphertext
        && current.agentState === currentView.agentStateCiphertext
        && current.metadataVersion > currentView.expectedMetadataVersion
        && current.agentStateVersion >= currentView.expectedAgentStateVersion;
    return matches
        ? {
            kind: "legacy_v0",
            metadataVersion: current.metadataVersion,
            agentStateVersion: current.agentStateVersion,
          }
        : null;
}

export async function commitSessionAgentCurrentViewInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    currentView: SessionAgentTransitionCurrentViewWriteV1;
}>): Promise<CommitSessionAgentCurrentViewResult> {
    const { tx, actorUserId, sessionId, currentView } = params;

    const access = await ensureSessionOwnerAccessInTx(tx, { actorUserId, sessionId });
    if (!access.ok) {
        return { ok: false, error: access.error };
    }

    const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: {
            active: true,
            archivedAt: true,
            metadata: true,
            metadataVersion: true,
            agentState: true,
            agentStateVersion: true,
        },
    });
    if (!session) {
        return { ok: false, error: "session-not-found" };
    }

    // The exact-replay check runs BEFORE the inactive and archive preconditions,
    // so a lost response can reconcile after the target has already been
    // activated. Replaying exactly the same sealed view is an idempotent
    // success, not a conflict.
    const alreadyCommitted = isExactCommittedTargetCurrentView(session, currentView);
    if (alreadyCommitted) {
        // The runtime-activity clear is NOT repeated: it committed in one
        // transaction with the current view this call is replaying, and the state
        // this check exists to serve is a lost response reconciling AFTER the
        // target started. Re-clearing would blank a working target.
        //
        // Nothing was written, so there are no cursors and nothing to announce.
        return {
            ok: true,
            currentView: alreadyCommitted,
            participantCursors: [],
            metadataCiphertext: currentView.metadataCiphertext,
            agentStateCiphertext: null,
        };
    }

    if (session.archivedAt !== null) {
        return { ok: false, error: "archived" };
    }
    // Read first so a still-running source is reported as `session-active`
    // rather than being flattened into the CAS predicate's generic loss.
    if (session.active) {
        return { ok: false, error: "session-active" };
    }
    if (session.agentStateVersion !== currentView.expectedAgentStateVersion) {
        return { ok: false, error: "version-mismatch" };
    }

    const cas = await applySessionMetadataVersionCasInTx({
        tx,
        sessionId,
        expectedVersion: currentView.expectedMetadataVersion,
        metadataCiphertext: currentView.metadataCiphertext,
        // Re-checked inside the write itself, so a Session that becomes active or
        // archived between the read above and the update cannot be cut over.
        additionalWhere: {
            active: false,
            archivedAt: null,
            agentStateVersion: currentView.expectedAgentStateVersion,
        },
        additionalData: {
            agentState: currentView.agentStateCiphertext,
            agentStateVersion: currentView.expectedAgentStateVersion + 1,
            thinking: false,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
        },
    });
    if (!cas.ok) {
        if (cas.error === "session-not-found") {
            return { ok: false, error: "session-not-found" };
        }
        if (cas.error === "version-mismatch") {
            return { ok: false, error: "version-mismatch" };
        }
        // The metadata version still holds, so the loss is the lifecycle
        // precondition. Name which one, using the freshly re-read row.
        const fresh = await tx.session.findUnique({
            where: { id: sessionId },
            select: { active: true, archivedAt: true, agentStateVersion: true },
        });
        if (!fresh) return { ok: false, error: "session-not-found" };
        if (fresh.archivedAt !== null) return { ok: false, error: "archived" };
        if (fresh.active) return { ok: false, error: "session-active" };
        return { ok: false, error: "version-mismatch" };
    }

    const activity = await writeSessionRuntimeActivityObserverLossInTx({ tx, sessionId });
    if (activity.status === "rejected") {
        // The metadata CAS above already wrote, so returning a failure value here
        // would COMMIT a half-cleared current view. Throw so the transaction rolls
        // back and the caller reports no effect. `not_found`/`archived` contradict
        // the checks above and a revision overflow is a real storage failure, so
        // none of these are an expected outcome worth a typed arm.
        throw new Error(`Session runtime activity clear rejected during Agent transition cutover: ${activity.reason}`);
    }

    const participantCursors = await markSessionParticipantsChanged({ tx, sessionId });

    return {
        ok: true,
        currentView: {
            kind: "legacy_v0",
            metadataVersion: cas.version,
            agentStateVersion: currentView.expectedAgentStateVersion + 1,
        },
        participantCursors,
        metadataCiphertext: currentView.metadataCiphertext,
        agentStateCiphertext: null,
    };
}

export async function commitSessionAgentCurrentView(
    params: CommitSessionAgentCurrentViewParams,
): Promise<CommitSessionAgentCurrentViewResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId.trim() : "";
    const metadataCiphertext = typeof params.currentView?.metadataCiphertext === "string"
        ? params.currentView.metadataCiphertext
        : "";
    if (
        !sessionId
        || !actorUserId
        || !metadataCiphertext
        || params.currentView.kind !== "legacy_v0"
        || params.currentView.agentStateCiphertext !== null
        || !isNonNegativeInteger(params.currentView.expectedMetadataVersion)
        || !isNonNegativeInteger(params.currentView.expectedAgentStateVersion)
    ) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => await commitSessionAgentCurrentViewInTx({
            tx,
            actorUserId,
            sessionId,
            currentView: params.currentView,
        }));
    } catch {
        return { ok: false, error: "internal" };
    }
}
