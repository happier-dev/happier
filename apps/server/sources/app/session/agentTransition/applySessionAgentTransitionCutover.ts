import { isDeepStrictEqual } from "node:util";

import {
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    isSessionAgentTransitionDividerLocalId,
    type SessionMessageAttentionImpact,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";

import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { createSessionMessage, type CreateSessionMessageResult } from "@/app/session/sessionWriteService";

type SessionMessageRow = Extract<CreateSessionMessageResult, { ok: true }>["message"];

import {
    commitSessionAgentCurrentView,
    type CommitSessionAgentCurrentViewErrorV1,
    type SessionAgentTransitionCommittedCurrentViewV1,
    type SessionAgentTransitionCurrentViewWriteV1,
} from "./commitSessionAgentCurrentView";

/**
 * The ordered Agent-transition cutover: sealed target current view, then the
 * transition divider.
 *
 * The two steps are DELIBERATELY not one transaction. The divider must be
 * written by `createSessionMessage`, because a raw in-transaction transcript
 * write would bypass its localId reconciliation, access checks, participant
 * cursors, badge accounting and publication. This tree has no transaction-local
 * transcript-message writer at all, so there is nothing to compose with even if
 * those behaviors were expendable — which they are not.
 *
 * Publisher fencing is deliberately NOT in that list, and naming it here was
 * wrong: the fence compares against a CURRENT session publisher, and the source
 * publisher is gone by the time the cutover runs. Owner-only reachability plus
 * the reserved-localId prefix every generic client ingress refuses is what
 * protects this write instead.
 *
 * The accepted consequence is one narrow crash window: current view committed,
 * divider absent. That is reported honestly as
 * `effect: 'current_view_committed'` and surfaces to the client as
 * `partially_applied` / `divider_unavailable`. No marker, receipt or phase row is
 * persisted to close it.
 *
 * Idempotency of the divider is the message owner's localId reconciliation. This
 * non-trusted write explicitly requests its `identical-or-conflict` policy: an
 * exact stored message replays at its existing sequence, while a difference is
 * refused without revising or republishing the winner. This write cannot acquire
 * trusted provenance — that path is gated on
 * `trustedTranscriptObservationProvenance`, not on actor-is-owner plus role
 * `event`, and its fence is against a current publisher that no longer exists
 * after the planned stop.
 */
export type SessionAgentTransitionDividerWriteV1 = Readonly<{
    localId: string;
    /** Sealed by the daemon: `{ t: 'plain', v }` or `{ t: 'encrypted', c }`. */
    content: PrismaJson.SessionMessageContent;
}>;

export type ApplySessionAgentTransitionCutoverParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    currentView: SessionAgentTransitionCurrentViewWriteV1;
    divider: SessionAgentTransitionDividerWriteV1;
}>;

export type ApplySessionAgentTransitionCutoverResult =
    | {
        ok: true;
        dividerSeq: number;
        dividerDidWrite: boolean;
        dividerMessage: SessionMessageRow;
        currentView: SessionAgentTransitionCommittedCurrentViewV1;
        metadataCiphertext: string;
        agentStateCiphertext: null;
        participantCursors: SessionParticipantCursor[];
        dividerParticipantCursors: SessionParticipantCursor[];
        attentionImpact: SessionMessageAttentionImpact;
      }
    | { ok: false; effect: "none"; error: CommitSessionAgentCurrentViewErrorV1 }
    | {
        ok: false;
        effect: "current_view_committed";
        error: "divider-conflict" | "divider-rejected" | "internal";
        currentView: SessionAgentTransitionCommittedCurrentViewV1;
        metadataCiphertext: string;
        agentStateCiphertext: null;
        participantCursors: SessionParticipantCursor[];
      };

export async function applySessionAgentTransitionCutover(
    params: ApplySessionAgentTransitionCutoverParams,
): Promise<ApplySessionAgentTransitionCutoverResult> {
    const dividerLocalId = typeof params.divider?.localId === "string" ? params.divider.localId : "";
    if (!isSessionAgentTransitionDividerLocalId(dividerLocalId)) {
        // The reserved namespace is the whole reason the generic ingresses can
        // reject it. A cutover that did not use it would create a divider a
        // client could later forge or overwrite.
        return { ok: false, effect: "none", error: "invalid-params" };
    }

    const committed = await commitSessionAgentCurrentView({
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
        currentView: params.currentView,
    });
    if (!committed.ok) {
        return { ok: false, effect: "none", error: committed.error };
    }

    const committedEffect = {
        currentView: committed.currentView,
        metadataCiphertext: committed.metadataCiphertext,
        agentStateCiphertext: committed.agentStateCiphertext,
        participantCursors: committed.participantCursors,
    } as const;

    // Report a conflicting boundary early when it already exists. This read is
    // not the race authority: a competing divider can commit after it returns
    // absent, and the canonical writer's immutable local-ID policy below then
    // returns the same conflict without mutating the winner.
    //
    // Comparing the stored bytes is sound in both encryption modes: the daemon
    // seals the divider with `encryptSessionPayload({ …,
    // idempotencyKey: dividerLocalId })`, whose derived nonce makes a re-seal
    // of the same payload byte-identical. The server therefore keeps one
    // opaque comparator rather than a second decryption decision path.
    const existingDivider = await db.sessionMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: dividerLocalId } },
        select: { content: true },
    });
    if (existingDivider && !isDeepStrictEqual(existingDivider.content, params.divider.content)) {
        return {
            ok: false,
            effect: "current_view_committed",
            error: "divider-conflict",
            ...committedEffect,
        };
    }

    const divider = await createSessionMessage({
        actorUserId: params.actorUserId,
        sessionId: params.sessionId,
        localId: dividerLocalId,
        localIdConflictPolicy: "identical-or-conflict",
        messageRole: "event",
        content: params.divider.content,
        trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    });

    if (!divider.ok) {
        return {
            ok: false,
            effect: "current_view_committed",
            error: divider.error === "local-id-conflict"
                ? "divider-conflict"
                : divider.error === "internal" ? "internal" : "divider-rejected",
            ...committedEffect,
        };
    }

    return {
        ok: true,
        dividerSeq: divider.message.seq,
        dividerDidWrite: divider.didWrite,
        dividerMessage: divider.message,
        ...committedEffect,
        dividerParticipantCursors: divider.participantCursors,
        attentionImpact: divider.didWrite
            ? divider.attentionImpact
            : SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    };
}
