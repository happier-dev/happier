import { readCurrentSessionPublicationAudienceInTx } from "@/app/session/access/sessionRecipients";
import {
    isFiniteSessionTranscriptPublicationRecipient,
    loadSessionTranscriptPublication,
    type SessionTranscriptPublicationFields,
    projectSessionTranscriptPublicationChangeHint,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import type { Tx } from "@/storage/inTx";
import { isSessionSystemRecordUnchangedHintV1 } from '@happier-dev/protocol/sessions/board/changeHint';
import { publishesSessionCurrentViewForAccount, type SessionCurrentViewPublicationAudience } from '@/app/session/metadata/publishSessionCurrentViewUpdates';
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
    /** False when this writer changed only a projection, not a Follow source fact. */
    followSourceChanged?: boolean;
    /** False only at a writer that changes no Usage rows, transcript counts or publication ceiling. */
    usageAccountingChanged?: false;
    /**
     * False only at writers that change no daemon Memory input: Memory reads the transcript
     * (Session `seq`), owner metadata locality, archive state and createdAt/updatedAt.
     * Activity, presence, ready, pending-queue, turn-status and Agent-state writers qualify.
     */
    memoryInputsChanged?: false;
    /**
     * False at writers that leave owner metadata (Memory locality) unchanged: transcript writers
     * and every `memoryInputsChanged: false` writer. Any other write withdraws the proof.
     */
    memoryLocalityChanged?: false;
    /** Only canonical receiver lifecycle/presence writers mark an availability event. */
    followReceiverAvailabilityChanged?: boolean;
    recipientAccountIds?: readonly string[];
    /** A writer's own row, returned by its Session update in this transaction; omitted reads it. */
    publication?: SessionTranscriptPublicationFields;
    hintForRecipient?: (accountId: string) => unknown;
    /** Only writers whose caller publishes the committed current view may supply this. */
    currentViewPublication?: SessionCurrentViewPublicationAudience;
    /**
     * Only writers whose every caller pushes this row change to each recipient's Session
     * audience (`all-interested-in-session`) at the returned cursor may supply this. Like a
     * current-view publication, that push replaces those sockets' duplicate wake; a finite
     * collaborator's push and hint are filtered separately, so it keeps its wake.
     */
    sessionAudienceReceivesUpdate?: true;
}): Promise<SessionRecipientPublication[]> {
    const { publication, recipientAccountIds } = params.recipientAccountIds
        ? { publication: params.publication ?? await loadSessionTranscriptPublication(params.tx, params.sessionId),
            recipientAccountIds: params.recipientAccountIds }
        : await readCurrentSessionPublicationAudienceInTx(params.tx, { sessionId: params.sessionId });

    const hints = new Map(recipientAccountIds.map(accountId => [accountId,
        projectSessionTranscriptPublicationChangeHint(
            params.hintForRecipient ? params.hintForRecipient(accountId) : params.hint,
            publication,
            accountId,
        ),
    ]));
    const destinationRecipients = params.followSourceChanged === false
        ? new Map<string, readonly string[]>()
        : await resolveSessionFollowSourceChangeRecipientsInTx(params.tx, { sourceSessionId: params.sessionId });
    // The source and its destinations may have different audiences. Fence their union
    // once before any cursor, rather than discovering a lower Account id later.
    await acquireAccountChangePublicationLocksInTx(params.tx, [
        ...[...hints].filter(([, hint]) => hint.kind === "publish").map(([accountId]) => accountId),
        ...[...destinationRecipients.values()].flat(),
    ]);
    const currentViewPublication = params.currentViewPublication;
    const audienceReceivesUpdate = (accountId: string) => params.sessionAudienceReceivesUpdate === true
        ? !isFiniteSessionTranscriptPublicationRecipient(publication, accountId)
        : currentViewPublication !== undefined && publishesSessionCurrentViewForAccount(currentViewPublication, accountId);
    const cursors = await markAccountChangesForSessionAccounts({
        tx: params.tx,
        sessionId: params.sessionId,
        accountIds: recipientAccountIds,
        // A supplied publication is the writer's own Session update in this transaction: the row exists.
        ...(params.publication !== undefined ? { sessionRowWrittenInTx: true as const } : {}),
        currentViewForAccount: currentViewPublication || params.sessionAudienceReceivesUpdate ? accountId => {
            const hint = hints.get(accountId);
            return hint?.kind === 'publish' && isSessionSystemRecordUnchangedHintV1(hint.value)
                && audienceReceivesUpdate(accountId);
        } : undefined,
        hintForAccount: (accountId) => {
            const hint = hints.get(accountId);
            return !hint || hint.kind === "suppress"
                ? { kind: "suppress" }
                : { kind: "publish", value: {
                    ...(hint.value && typeof hint.value === 'object' && !Array.isArray(hint.value) ? hint.value : {}),
                    ...(params.followSourceChanged === false ? { followSourceChanged: false } : {}),
                    ...(params.usageAccountingChanged === false ? { usageAccountingChanged: false } : {}),
                    ...(params.memoryInputsChanged === false ? { memoryInputsChanged: false } : {}),
                    ...(params.memoryInputsChanged === false || params.memoryLocalityChanged === false
                        ? { memoryLocalityChanged: false } : {}),
                    // A pushed fact for unrestricted recipients; a finite recipient's ceiling governs its seq.
                    ...(typeof publication.seq === 'number' && !isFiniteSessionTranscriptPublicationRecipient(publication, accountId)
                        ? { transcriptSeq: publication.seq } : {}),
                    followReceiverAvailabilityChanged: params.followReceiverAvailabilityChanged === true,
                } };
        },
    });
    await invalidateSessionFollowDestinationsForSourceChangeInTx(params.tx, {
        sourceSessionId: params.sessionId,
        recipientsBySession: destinationRecipients,
    });
    return cursors;
}
