import { isSessionSystemRecordUnchangedHintV1 } from '@happier-dev/protocol/sessions/board/changeHint';
import { publishesSessionCurrentViewForAccount, type SessionCurrentViewPublicationAudience } from '@/app/session/metadata/publishSessionCurrentViewUpdates';
import { resolveCurrentSessionRecipientAccountIdsInTx } from "@/app/session/access/sessionRecipients";
import {
    loadSessionTranscriptPublication,
    projectSessionTranscriptPublicationChangeHint,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import type { Tx } from "@/storage/inTx";
import {
    markAccountChangesForSessionAccounts,
    type SessionAccountChangeCursor,
    type SessionAccountChangePublication,
} from "./markAccountChangesForSessionAccounts";
import { invalidateSessionFollowDestinationsForSourceChangeInTx, resolveSessionFollowSourceChangeRecipientsInTx } from "@/app/session/follow/sessionFollowEdgeService";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";

export type SessionRecipientCursor = SessionAccountChangeCursor;
export type SessionRecipientPublication = SessionAccountChangePublication;

/**
 * Transcript-publication-aware fanout. It keeps its own publication filter and
 * delegates the actual AccountChange writes to the generic Session fanout, so a
 * Session-owned domain that is not transcript publication can reuse the fanout
 * without inheriting this publication ceiling.
 *
 * The recipient set comes from the canonical Session access recipient resolver, so
 * a Team- or Group-granted collaborator receives the same projection invalidation
 * as a direct recipient. Callers that already resolved the affected Accounts inside
 * their own transaction pass them explicitly instead.
 */
export async function markSessionProjectionRecipientsChanged(params: {
    tx: Tx;
    sessionId: string;
    hint?: unknown;
    recipientAccountIds?: readonly string[];
    hintForRecipient?: (accountId: string) => unknown;
    currentViewPublication?: SessionCurrentViewPublicationAudience;
}): Promise<SessionRecipientPublication[]> {
    const publication = await loadSessionTranscriptPublication(params.tx, params.sessionId);
    const recipientAccountIds = params.recipientAccountIds
        ?? await resolveCurrentSessionRecipientAccountIdsInTx(params.tx, {
            sessionId: params.sessionId,
        });

    const hints = new Map(recipientAccountIds.map(accountId => [accountId,
        projectSessionTranscriptPublicationChangeHint(
            params.hintForRecipient ? params.hintForRecipient(accountId) : params.hint,
            publication,
            accountId,
        ),
    ]));
    const destinationRecipients = await resolveSessionFollowSourceChangeRecipientsInTx(params.tx, { sourceSessionId: params.sessionId });
    // The source and its destinations may have different audiences. Fence their union
    // once before any cursor, rather than discovering a lower Account id later.
    await acquireAccountChangePublicationLocksInTx(params.tx, [
        ...[...hints].filter(([, hint]) => hint.kind === "publish").map(([accountId]) => accountId),
        ...[...destinationRecipients.values()].flat(),
    ]);
    const currentViewPublication = params.currentViewPublication;
    const cursors = await markAccountChangesForSessionAccounts({
        tx: params.tx,
        sessionId: params.sessionId,
        accountIds: recipientAccountIds,
        currentViewForAccount: currentViewPublication ? accountId => {
            const hint = hints.get(accountId);
            return hint?.kind === 'publish' && isSessionSystemRecordUnchangedHintV1(hint.value)
                && publishesSessionCurrentViewForAccount(currentViewPublication, accountId);
        } : undefined,

        hintForAccount: (accountId) => {
            const hint = hints.get(accountId);
            return !hint || hint.kind === "suppress"
                ? { kind: "suppress" }
                : { kind: "publish", value: hint.value };
        },
    });
    await invalidateSessionFollowDestinationsForSourceChangeInTx(params.tx, {
        sourceSessionId: params.sessionId,
        recipientsBySession: destinationRecipients,
    });
    return cursors;
}
