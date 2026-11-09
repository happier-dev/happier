import type { SessionMessageObservationFactsV1} from '@happier-dev/protocol/sessions';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { isRecoveredHistoryTranscriptObservation, storedSessionMessageAttentionImpact } from '@happier-dev/session-core/messages';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import { readSessionFullPublicationUpdatedAt } from '@/sync/domains/session/sessionRuntimeObservation';

export type MessageSessionProjectionPatch = Partial<{
    seq: number;
    updatedAt: number;
    meaningfulActivityAt: number;
}>;

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Message observations update the same scalar facts in full shells and Home list rows. */
export function buildMessageSessionProjectionPatch(params: Readonly<{
    session: Readonly<{
        id?: string | null;
        serverId?: string | null;
        seq?: number | null;
        updatedAt?: number | null;
        meaningfulActivityAt?: number | null;
    }>;
    updateData: Readonly<{ seq: number; createdAt: number }>;
    rawMessage: SessionMessageV1 | SessionMessageObservationFactsV1 | undefined;
    messageSeq: number | null;
    updateType: 'new-message' | 'message-updated';
    projectionOnly?: boolean;
}>): MessageSessionProjectionPatch {
    const currentSeq = params.session.seq ?? 0;
    const isRecoveredHistory = isRecoveredHistoryTranscriptObservation(params.rawMessage);
    const attentionImpact = storedSessionMessageAttentionImpact(params.rawMessage);
    const nextSessionSeq = computeNextSessionSeqFromUpdate({
        currentSessionSeq: currentSeq,
        updateType: 'new-message',
        containerSeq: params.updateData.seq,
        messageSeq: params.messageSeq ?? undefined,
    });
    const updateCreatedAt = finiteNumber(params.updateData.createdAt);
    const nextMeaningfulActivityAt = attentionImpact.affectsMeaningfulActivity
        ? finiteNumber(params.rawMessage?.createdAt) ?? updateCreatedAt : null;
    const currentMeaningfulActivityAt = finiteNumber(params.session.meaningfulActivityAt);
    const advancesSeq = nextSessionSeq > currentSeq;
    const advancesMeaningfulActivityAt = nextMeaningfulActivityAt !== null
        && (currentMeaningfulActivityAt === null || nextMeaningfulActivityAt > currentMeaningfulActivityAt);
    // Materialized edits already publish their transcript row. Pure event-time advances
    // only need a row publication on the scalar-only path.
    const advancesUpdatedAt = !isRecoveredHistory && updateCreatedAt !== null
        && updateCreatedAt > readSessionFullPublicationUpdatedAt(params.session)
        && (params.projectionOnly || params.updateType === 'new-message' || advancesSeq || advancesMeaningfulActivityAt);
    return {
        ...(advancesSeq ? { seq: nextSessionSeq } : {}),
        ...(advancesUpdatedAt ? { updatedAt: updateCreatedAt } : {}),
        ...(advancesMeaningfulActivityAt ? { meaningfulActivityAt: nextMeaningfulActivityAt } : {}),
    };
}
