import {
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    isSameSessionAgentTransitionDividerV1,
    isSessionAgentTransitionDividerLocalId,
    readSessionAgentTransitionDividerFromStoredRecordV1,
} from "@happier-dev/protocol";

import {
    createSessionMessage,
    type CreateSessionMessageResult,
} from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";

import {
    commitSessionAgentCurrentView,
    type CommitSessionAgentCurrentViewError,
    type CommitSessionAgentCurrentViewParams,
    type CommitSessionAgentCurrentViewResult,
} from "./commitSessionAgentCurrentView";

/**
 * Same-Session cross-Agent transition — the ordered cutover.
 *
 * Two existing owner boundaries are crossed IN ORDER and deliberately not forced
 * into one database transaction:
 *
 *   1. `commitSessionAgentCurrentView` — one narrow transaction writing the sealed
 *      target current view and clearing the current runtime projections.
 *   2. the canonical `createSessionMessage` owner — an ordered idempotent divider
 *      append in its own normal transaction.
 *
 * The split is NOT because atomicity would need a new extraction:
 * `writeSessionTranscriptMessageInTx` already exists and already has two
 * in-transaction callers. The split exists because a raw in-transaction
 * transcript write would bypass the behaviors `createSessionMessage` layers on
 * top of it, and this write genuinely exercises each one: session edit access,
 * stored-content admission for the Account's encryption mode, hosted write
 * authority, message-role resolution, the activity/ready projection, participant
 * change cursors, the read-cursor advance and badge accounting that keep the
 * divider from minting a phantom unread, and the publication inputs the route
 * emits. Anyone revisiting this split must argue those bypassed behaviors.
 *
 * Publisher fencing is deliberately NOT in that list. It is reached only on the
 * trusted-provenance path, and this write cannot use it: the fence compares
 * against a CURRENT session publisher, and the source publisher is gone by the
 * time the cutover runs. Owner-only reachability is what protects the reserved
 * localId instead — every generic client ingress refuses the prefix.
 *
 * It accepts one narrow crash state — target current view committed, divider
 * absent — which the caller reports as `partially_applied` with
 * `divider_missing`. No transition marker, receipt, phase, or second transaction
 * is added to reconstruct the missing presentation event.
 */

export type SessionAgentTransitionDividerWriteV1 = {
    localId: string;
    content: PrismaJson.SessionMessageContent;
};

export type ApplySessionAgentTransitionCutoverParams =
    CommitSessionAgentCurrentViewParams & {
        divider: SessionAgentTransitionDividerWriteV1;
    };

type CommittedCurrentView = Extract<
    CommitSessionAgentCurrentViewResult,
    { ok: true }
>;

/**
 * What the current-view transaction committed and to whom it must be announced.
 * The route republishes it through the shared `publishSessionCurrentViewUpdates`
 * owner; an exact retry commits nothing and therefore carries no cursors and no
 * publication.
 */
type CommittedCurrentViewPublication = Pick<
    CommittedCurrentView,
    "currentView" | "participantCursors" | "publication"
>;

type SuccessfulCreateSessionMessageResult = Extract<
    CreateSessionMessageResult,
    { ok: true }
>;

export type ApplySessionAgentTransitionCutoverResult =
    | {
        ok: true;
        dividerSeq: number;
        currentView: CommittedCurrentViewPublication;
        /**
         * Present only when this call actually wrote or updated the divider
         * row. A same-localId re-append returns the existing sequence with
         * nothing to publish, so the caller emits no update and moves no cursor.
         */
        dividerWrite: SuccessfulCreateSessionMessageResult | null;
        /**
         * A row already existed at the reserved localId and the server cannot
         * read it, so it cannot establish that this operation wrote it. The
         * current view IS committed, but the divider is unverified: the daemon
         * must decrypt and compare it through `readDividerEvidence` before
         * admitting input or activating the target. Absent whenever the server
         * verified the row itself or wrote it.
         */
        dividerVerificationRequired?: true;
      }
    | {
        ok: false;
        effect: "none";
        error: CommitSessionAgentCurrentViewError;
      }
    | {
        ok: false;
        effect: "current_view_committed";
        error: "divider-conflict" | "divider-rejected" | "internal";
        /**
         * The SAME committed current view the success arm carries. The divider
         * failing does not un-commit it, so withholding it would leave every
         * other connected client showing the old Agent until a change-cursor
         * catch-up while this response already admits the write landed. The
         * divider failure surfaces through `error`, not by muting the effect
         * that did happen.
         */
        currentView: CommittedCurrentViewPublication;
      };

/**
 * Divider idempotency, stated against ACTUAL owner behavior.
 *
 * `createSessionMessage` does NOT conflict on differing content at an existing
 * localId — it overwrites the row in place at the current revision, keeping the
 * same sequence. So this service must decide before delegating, and it never
 * issues a write when a row already exists at the reserved localId:
 *
 * - identical transition payload -> success at the existing sequence, with no new
 *   sequence, no cursor movement, and no republication;
 * - a provably DIFFERENT payload -> `divider-conflict`. That is a conflicting or
 *   stale operation, resolved by the caller's recovery projection, not a content
 *   correction.
 *
 * For an E2EE Session the stored content is opaque ciphertext, so "provably
 * different" is not decidable HERE. Re-sealing the same payload yields different
 * bytes, so comparing ciphertext would report a false conflict on every
 * legitimate retry. The server must therefore neither conflict on it nor trust
 * it: uniqueness of the reserved localId is not proof of authorship, because a
 * reserved row can be reached by an ingress the transition does not own. It
 * returns `existing-unverified`, which the caller surfaces as
 * `dividerVerificationRequired` so the DAEMON — the only party holding the key —
 * decides through its existing `readDividerEvidence` decrypt-and-compare owner
 * before admission or activation. No second comparison engine is added here.
 *
 * In both modes the row is still never overwritten.
 *
 * This read is not transactionally fenced against a concurrent writer, and no
 * lock is added: two concurrent calls at the same reserved localId with
 * DIFFERENT payloads would require the current-view CAS to succeed twice with
 * different target views, and the second attempt loses that CAS.
 */
async function resolveExistingDividerDisposition(params: Readonly<{
    sessionId: string;
    localId: string;
    candidateContent: PrismaJson.SessionMessageContent;
}>): Promise<
    | { kind: "absent" }
    | { kind: "same-operation"; seq: number }
    | { kind: "existing-unverified"; seq: number }
    | { kind: "conflict" }
> {
    const existing = await db.sessionMessage.findUnique({
        where: {
            sessionId_localId: {
                sessionId: params.sessionId,
                localId: params.localId,
            },
        },
        select: { seq: true, content: true },
    });
    if (!existing) return { kind: "absent" };

    const stored = existing.content as PrismaJson.SessionMessageContent | null;
    if (!stored || stored.t !== "plain" || params.candidateContent.t !== "plain") {
        // Opaque to the server: it can neither confirm nor refute authorship.
        // The daemon verifies before anything acts on this row.
        return { kind: "existing-unverified", seq: existing.seq };
    }

    // Both rows are read at the reserved localId this lookup keyed on, so the
    // canonical reader gets the full divider identity rather than the sidecar
    // alone.
    const storedDivider = readSessionAgentTransitionDividerFromStoredRecordV1({
        localId: params.localId,
        record: stored.v,
    });
    const candidateDivider = readSessionAgentTransitionDividerFromStoredRecordV1({
        localId: params.localId,
        record: params.candidateContent.v,
    });
    if (!storedDivider || !candidateDivider) return { kind: "conflict" };
    return isSameSessionAgentTransitionDividerV1(storedDivider, candidateDivider)
        ? { kind: "same-operation", seq: existing.seq }
        : { kind: "conflict" };
}

export async function applySessionAgentTransitionCutover(
    params: ApplySessionAgentTransitionCutoverParams,
): Promise<ApplySessionAgentTransitionCutoverResult> {
    if (!isSessionAgentTransitionDividerLocalId(params.divider?.localId)) {
        return { ok: false, effect: "none", error: "invalid-params" };
    }
    if (!params.divider.content) {
        return { ok: false, effect: "none", error: "invalid-params" };
    }

    const committed = await commitSessionAgentCurrentView(params);
    if (!committed.ok) {
        return { ok: false, effect: "none", error: committed.error };
    }

    // Built BEFORE the divider work so every committed-effect return — success
    // or failure — announces the same thing.
    const committedCurrentView: CommittedCurrentViewPublication = {
        currentView: committed.currentView,
        participantCursors: committed.participantCursors,
        publication: committed.publication,
    };

    let disposition: Awaited<ReturnType<typeof resolveExistingDividerDisposition>>;
    try {
        disposition = await resolveExistingDividerDisposition({
            sessionId: params.sessionId,
            localId: params.divider.localId,
            candidateContent: params.divider.content,
        });
    } catch {
        return {
            ok: false,
            effect: "current_view_committed",
            error: "internal",
            currentView: committedCurrentView,
        };
    }
    if (disposition.kind === "conflict") {
        return {
            ok: false,
            effect: "current_view_committed",
            error: "divider-conflict",
            currentView: committedCurrentView,
        };
    }

    if (disposition.kind === "same-operation" || disposition.kind === "existing-unverified") {
        // No new sequence, no cursor movement, no republication of the divider.
        return {
            ok: true,
            dividerSeq: disposition.seq,
            currentView: committedCurrentView,
            dividerWrite: null,
            ...(disposition.kind === "existing-unverified"
                ? { dividerVerificationRequired: true as const }
                : {}),
        };
    }

    // The divider is written through the UNCHANGED canonical message owner so it
    // keeps Account-mode validation, storage/sequence allocation, activity,
    // participant/read-cursor, badge, and publication behavior. The write-time
    // no-attention impact is necessary but not sufficient: `attentionImpact` is
    // not a persisted column, so the divider is truly no-attention only because
    // the shared `agentEventAttentionImpact` owner recognizes the
    // `sessionAgentTransitionV1` sidecar on every re-read.
    const written = await createSessionMessage({
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
        content: params.divider.content,
        localId: params.divider.localId,
        messageRole: "event",
        trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    });
    if (!written.ok) {
        return {
            ok: false,
            effect: "current_view_committed",
            error: written.error === "internal" ? "internal" : "divider-rejected",
            currentView: committedCurrentView,
        };
    }
    return {
        ok: true,
        dividerSeq: written.message.seq,
        currentView: committedCurrentView,
        dividerWrite: written,
    };
}
