import { isDeepStrictEqual } from "node:util";

import {
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    isSessionAgentTransitionDividerLocalId,
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
 * `divider_unavailable`. No transition marker, receipt, phase, or second transaction
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
 * Divider idempotency is owned by `createSessionMessage`.
 *
 * Ordinary local IDs may reconcile a changed payload as a correction. The
 * reserved transition divider explicitly requests the writer's
 * `identical-or-conflict` policy instead: an exact stored message replays at
 * its existing sequence, while any difference is a typed conflict that does
 * not update the row, its revision, or its publication.
 *
 * The divider producer derives the E2EE nonce from its stable localId and full
 * canonical payload, so an exact retry has the same stored bytes in either
 * mode. A different writer can still commit after this lookup returns absent.
 * That unique-key race is resolved by the canonical writer policy below, not
 * by this read or by the current-view CAS.
 */
async function resolveExistingDividerDisposition(params: Readonly<{
    sessionId: string;
    localId: string;
    candidateContent: PrismaJson.SessionMessageContent;
}>): Promise<
    | { kind: "absent" }
    | { kind: "same-operation"; seq: number }
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

    return isDeepStrictEqual(existing.content, params.candidateContent)
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

    if (disposition.kind === "same-operation") {
        // No new sequence, no cursor movement, no republication of the divider.
        return {
            ok: true,
            dividerSeq: disposition.seq,
            currentView: committedCurrentView,
            dividerWrite: null,
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
        localIdConflictPolicy: "identical-or-conflict",
        messageRole: "event",
        trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    });
    if (!written.ok) {
        return {
            ok: false,
            effect: "current_view_committed",
            error: written.error === "local-id-conflict"
                ? "divider-conflict"
                : written.error === "internal" ? "internal" : "divider-rejected",
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
