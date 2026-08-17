import {
    encodeSessionOwnerMetadataEnvelopeV1,
    SESSION_METADATA_LAYOUT_VERSION_V1,
    type SessionMetadataInactiveModelIntentOwnerPatchV1,
} from "@happier-dev/protocol";

import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type {
    SessionCurrentViewPublicationSourceV1,
} from "@/app/session/metadata/publishSessionCurrentViewUpdates";
import {
    clearSessionRuntimeActivityProjectionInTx,
    clearSessionSourceRuntimeRequestProjectionsInTx,
    ensureSessionEditAccess,
    patchSessionInTx,
    updateSessionMetadataEnvelopeTupleInTx,
} from "@/app/session/sessionWriteService";
import { inTx, type Tx } from "@/storage/inTx";

/**
 * Same-Session cross-Agent transition — the narrow current-view transaction.
 *
 * ONE transaction proves owner access, requires `archivedAt = null` and
 * `active = false`, applies the expected metadata/version CAS, writes the sealed
 * target current view, and clears the current runtime-activity projection. It is
 * the only thing the cutover makes atomic; the divider is appended afterwards
 * through the canonical message owner (see `applySessionAgentTransitionCutover`).
 *
 * The inactive precondition is NOT re-implemented here. Layout one reuses the
 * shipped `owner_inactive_model_intent` patch mode, which already enforces
 * `active = false` in its update predicate and re-checks the fresh row inside the
 * transaction; layout zero reuses `patchSessionInTx`'s
 * `{ kind: 'inactive_model_intent' }` session expectation, which does the same.
 * There is no second inactive predicate and no `requireInactiveSession` option.
 *
 * The server never decrypts owner content. It validates envelopes and currentness
 * only; the daemon has already sealed the target view.
 */

/**
 * The sealed target current view, by stored metadata layout. `legacy_v0` is the
 * layout-zero metadata/AgentState pair; `envelope_tuple_v1` carries the shipped
 * inactive-model-intent owner patch unchanged.
 *
 * `agentStateCiphertext` is `null` by construction: §8 clears AgentState at the
 * cutover and the target republishes it.
 */
export type SessionAgentTransitionCurrentViewWriteV1 =
    | {
        kind: "legacy_v0";
        expectedMetadataVersion: number;
        metadataCiphertext: string;
        expectedAgentStateVersion: number;
        agentStateCiphertext: null;
      }
    | {
        kind: "envelope_tuple_v1";
        ownerPatch: SessionMetadataInactiveModelIntentOwnerPatchV1;
      };

export type CommitSessionAgentCurrentViewParams = {
    actorUserId: string;
    sessionId: string;
    currentView: SessionAgentTransitionCurrentViewWriteV1;
};

export type CommitSessionAgentCurrentViewError =
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
        currentView:
            | { kind: "legacy_v0"; metadataVersion: number; agentStateVersion: number }
            | { kind: "envelope_tuple_v1"; sharedMetadataVersion: number; agentStateVersion: number };
        /**
         * Cursors bumped by this commit, and the projection input its layout
         * owner produced. Both exist so the route can announce the committed
         * current view through `publishSessionCurrentViewUpdates` — the same
         * publisher every other metadata writer uses. Empty cursors on the
         * exact-retry short circuit: that call committed nothing, so it has
         * nothing to announce.
         */
        participantCursors: SessionParticipantCursor[];
        publication: SessionCurrentViewPublicationSourceV1 | null;
      }
    | { ok: false; error: CommitSessionAgentCurrentViewError };

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateCurrentViewInput(
    currentView: SessionAgentTransitionCurrentViewWriteV1,
): boolean {
    if (currentView.kind === "legacy_v0") {
        return typeof currentView.metadataCiphertext === "string"
            && currentView.metadataCiphertext.length > 0
            && isNonNegativeInteger(currentView.expectedMetadataVersion)
            && isNonNegativeInteger(currentView.expectedAgentStateVersion)
            && currentView.agentStateCiphertext === null;
    }
    return currentView.ownerPatch?.mode === "owner_inactive_model_intent";
}

type StoredCurrentViewRow = Readonly<{
    metadataLayoutVersion: number | null;
    metadataVersion: number;
    metadata: string | null;
    ownerMetadata: string | null;
    agentStateVersion: number;
    agentState: string | null;
}>;

/**
 * True when the stored row already IS the exact target this call would write —
 * i.e. this call replays a write that already landed.
 *
 * Why this exists, since no caller replays today. The daemon coordinator never
 * re-invokes the cutover — a repeated transition diverts at preflight into
 * `reconcileAlreadyTargetedSession`, and the HTTP client deliberately does not
 * retry — so it is tempting to read this as dead. It is not a bespoke
 * transition mechanism: `apps/server/AGENTS.md` requires every retryable
 * operation to produce the same durable result as one call, and the two shipped
 * siblings on this very owner chain — `isExactMetadataEnvelopeTupleRetry` and
 * `isExactOwnerMigrationRetry` — already give the canonical patch route exactly
 * this property. Removing it would make the cutover the one metadata CAS
 * endpoint that answers a replay with `session-active`, which the coordinator
 * maps to an arm promising the Session was never touched. That promise would be
 * false. Both layouts are covered by the owner's integration spec.
 *
 * Content equality is the signal, not exact version arithmetic: the layout owners
 * do not bump a version whose value did not change (a no-op AgentState write
 * leaves `agentStateVersion` alone), so requiring `expected + 1` on every field
 * would miss real retries. The shared metadata version must have MOVED PAST the
 * expected one, which is what proves a write already landed — an unchanged first
 * attempt still takes the normal path and its preconditions.
 */
function isExactCommittedTargetCurrentView(
    current: StoredCurrentViewRow,
    currentView: SessionAgentTransitionCurrentViewWriteV1,
): Extract<CommitSessionAgentCurrentViewResult, { ok: true }>["currentView"] | null {
    if (currentView.kind === "legacy_v0") {
        const matches = (current.metadataLayoutVersion ?? 0) === 0
            && current.ownerMetadata === null
            && current.metadata === currentView.metadataCiphertext
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
    const patch = currentView.ownerPatch;
    const matches = current.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
        && current.metadata === patch.sharedMetadata.ciphertext
        && current.ownerMetadata === encodeSessionOwnerMetadataEnvelopeV1(patch.ownerMetadata)
        && current.agentState === patch.agentState.ciphertext
        && current.metadataVersion > patch.sharedMetadata.expectedVersion
        && current.agentStateVersion >= patch.agentState.expectedVersion;
    return matches
        ? {
            kind: "envelope_tuple_v1",
            sharedMetadataVersion: current.metadataVersion,
            agentStateVersion: current.agentStateVersion,
          }
        : null;
}

/**
 * Transaction-local core. Callers that already own a transaction (the cutover
 * service) use this so the current-view write and the projection clears cannot
 * be separated by a crash.
 */
export async function commitSessionAgentCurrentViewInTx(
    tx: Tx,
    params: CommitSessionAgentCurrentViewParams,
): Promise<CommitSessionAgentCurrentViewResult> {
    if (
        typeof params.actorUserId !== "string" || params.actorUserId.length === 0
        || typeof params.sessionId !== "string" || params.sessionId.length === 0
        || !validateCurrentViewInput(params.currentView)
    ) {
        return { ok: false, error: "invalid-params" };
    }

    // Owner access is proven here as well as inside each layout owner, because
    // the exact-retry short-circuit below returns before reaching them.
    const access = await ensureSessionEditAccess(tx, {
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
    });
    if (!access.ok) return { ok: false, error: access.error };
    if (access.sessionOwnerId !== params.actorUserId) {
        return { ok: false, error: "forbidden" };
    }

    const current = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            archivedAt: true,
            metadataLayoutVersion: true,
            metadataVersion: true,
            metadata: true,
            ownerMetadata: true,
            agentStateVersion: true,
            agentState: true,
        },
    });
    if (!current) return { ok: false, error: "session-not-found" };

    // The exact-current-view retry check runs BEFORE the inactive and archive
    // preconditions, so a lost response can reconcile after the target has
    // already been activated (PLAN §6.6). Replaying exactly the same sealed view
    // is an idempotent success, not a conflict.
    //
    // Layout one's shipped tuple owner performs the same check internally; this
    // one exists so both layouts order the check identically at this owner
    // instead of one of them failing closed on a precondition that the committed
    // write already satisfied.
    const alreadyCommitted = isExactCommittedTargetCurrentView(current, params.currentView);
    if (alreadyCommitted) {
        // The projection clear is NOT repeated. It committed in one transaction
        // with the current view that this call is replaying, so it has already
        // happened; and the state this check exists to serve is a lost response
        // reconciling AFTER the target started (PLAN §6.6), where the Activity
        // now on the row belongs to the new runtime. Re-clearing would blank a
        // working target back to `unknown`/0 until its next Activity transition.
        //
        // Nothing was written, so there are no cursors and nothing to announce.
        return {
            ok: true,
            currentView: alreadyCommitted,
            participantCursors: [],
            publication: null,
        };
    }

    // Archive state is user intent and the transition neither sets nor clears it.
    // A Session that archived itself on stop must fail the cutover loudly rather
    // than silently continuing (PLAN §2.3, §7.2, §8).
    //
    // This read is the cheap fast path, NOT the authority. The authority is the
    // `requireUnarchivedSession` precondition threaded into both layout CAS
    // owners below, because the archive route updates this same inactive row
    // with no version of its own: an archive committing between this read and
    // the write would otherwise let both operations commit, and unarchiving
    // would then reveal a current Agent and a divider the user never saw happen.
    // The predicate is a `archivedAt: null` term in the existing compare-and-set,
    // not a lock, lease, or fence.
    if (current.archivedAt !== null) return { ok: false, error: "archived" };

    if (params.currentView.kind === "legacy_v0") {
        const patched = await patchSessionInTx(tx, {
            actorUserId: params.actorUserId,
            sessionId: params.sessionId,
            metadata: {
                ciphertext: params.currentView.metadataCiphertext,
                expectedVersion: params.currentView.expectedMetadataVersion,
            },
            agentState: {
                ciphertext: params.currentView.agentStateCiphertext,
                expectedVersion: params.currentView.expectedAgentStateVersion,
            },
            sessionExpectation: { kind: "inactive_model_intent" },
        }, { requireUnarchivedSession: true });
        if (!patched.ok) {
            return { ok: false, error: toCommitError(patched.error) };
        }
        await clearSessionRuntimeActivityProjectionInTx({
            tx,
            sessionId: params.sessionId,
        });
        await clearSessionSourceRuntimeRequestProjectionsInTx({
            tx,
            sessionId: params.sessionId,
        });
        const patchedRow = await tx.session.findUnique({
            where: { id: params.sessionId },
            select: {
                accountId: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        });
        return {
            ok: true,
            currentView: {
                kind: "legacy_v0",
                metadataVersion: patched.metadata?.version
                    ?? params.currentView.expectedMetadataVersion,
                agentStateVersion: patched.agentState?.version
                    ?? params.currentView.expectedAgentStateVersion,
            },
            participantCursors: patched.participantCursors,
            // Read back inside the same transaction so the announced projection
            // is exactly the row this commit produced, and so the projector
            // keeps owning the layout dispatch.
            publication: patchedRow
                ? {
                    kind: "legacy_v0",
                    sessionOwnerId: params.actorUserId,
                    session: patchedRow,
                  }
                : null,
        };
    }

    const tuple = await updateSessionMetadataEnvelopeTupleInTx(tx, {
        ...params.currentView.ownerPatch,
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
    }, { requireUnarchivedSession: true });
    if (!tuple.ok) {
        return { ok: false, error: toCommitError(tuple.error) };
    }
    await clearSessionRuntimeActivityProjectionInTx({
        tx,
        sessionId: params.sessionId,
    });
    await clearSessionSourceRuntimeRequestProjectionsInTx({
        tx,
        sessionId: params.sessionId,
    });
    return {
        ok: true,
        currentView: {
            kind: "envelope_tuple_v1",
            sharedMetadataVersion: tuple.sharedMetadata.version,
            agentStateVersion: tuple.agentState.version,
        },
        participantCursors: tuple.participantCursors,
        // The tuple owner's own in-memory result, not a re-read: the announced
        // envelope must be the one this write committed.
        publication: {
            kind: "envelope_tuple_v1",
            sessionOwnerId: tuple.sessionOwnerId,
            ownerAccountMode: tuple.ownerAccountMode,
            sharedMetadata: tuple.sharedMetadata,
            ownerMetadata: tuple.ownerMetadata,
            agentState: tuple.agentState,
        },
    };
}

function toCommitError(
    error:
        | "invalid-params"
        | "forbidden"
        | "session-not-found"
        | "session_active"
        | "session_archived"
        | "version-mismatch"
        | "metadata_privacy_upgrade_required"
        | "publisher-superseded"
        | "internal",
): CommitSessionAgentCurrentViewError {
    if (error === "session_active") return "session-active";
    // The CAS lost to a concurrent archive. Nothing committed, so this rides the
    // same honest `archived`/`effect: none` arm the pre-read produces — never a
    // version conflict, which would tell the caller to refetch and retry.
    if (error === "session_archived") return "archived";
    if (error === "metadata_privacy_upgrade_required") return "invalid-params";
    if (error === "publisher-superseded") return "version-mismatch";
    return error;
}

export async function commitSessionAgentCurrentView(
    params: CommitSessionAgentCurrentViewParams,
): Promise<CommitSessionAgentCurrentViewResult> {
    try {
        return await inTx(async (tx) => await commitSessionAgentCurrentViewInTx(tx, params));
    } catch {
        return { ok: false, error: "internal" };
    }
}
