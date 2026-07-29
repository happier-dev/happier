import type { ReducerMessage, ReducerState } from '../reducer';
import { normalizeTranscriptBlockIndex, normalizeTranscriptSeq } from '../../domains/messages/transcriptOrdering';

import { readStreamSegmentMetaV1 } from './streamSegmentMeta';

function shouldApplyStreamSegmentSnapshotUpdate(args: Readonly<{
    prev: ReducerMessage;
    nextText: string;
    nextMeta: unknown;
    nextSeq: number | null;
}>): boolean {
    const prevSeq = normalizeTranscriptSeq(args.prev.seq);
    if (prevSeq !== null && args.nextSeq !== null && args.nextSeq < prevSeq) {
        return false;
    }

    const prevUpdatedAtMs = readStreamSegmentMetaV1(args.prev.meta)?.updatedAtMs ?? null;
    const nextUpdatedAtMs = readStreamSegmentMetaV1(args.nextMeta)?.updatedAtMs ?? null;
    if (prevUpdatedAtMs !== null && nextUpdatedAtMs !== null && nextUpdatedAtMs < prevUpdatedAtMs) {
        return false;
    }

    return true;
}

export function upsertStreamSegmentSnapshotMessage(args: Readonly<{
    state: ReducerState;
    allocateId: () => string;
    localId: string;
    realID: string;
    createdAt: number;
    seq: unknown;
    transcriptBlockIndex?: number | null;
    isThinking: boolean;
    text: string;
    meta: unknown;
    markChanged: (messageId: string) => void;
    onCreate?: (message: ReducerMessage) => void;
}>): Readonly<{ messageId: string | null; didCreate: boolean; accepted: boolean }> {
    const existingId = args.state.localIds.get(args.localId) ?? null;
    const nextText = args.text;
    const nextSeq = normalizeTranscriptSeq(args.seq);
    const nextBlockIndex = normalizeTranscriptBlockIndex(args.transcriptBlockIndex);

    if (existingId) {
        const prev = args.state.messages.get(existingId) ?? null;
        if (!prev || prev.role !== 'agent' || Boolean(prev.isThinking) !== args.isThinking) {
            return { messageId: null, didCreate: false, accepted: false };
        }
        if (!shouldApplyStreamSegmentSnapshotUpdate({ prev, nextText, nextMeta: args.meta, nextSeq })) {
            return { messageId: existingId, didCreate: false, accepted: false };
        }

        const hasChanges = prev.text !== nextText || prev.meta !== args.meta;
        const shouldApplyBlockIndex =
            prev.transcriptBlockIndex == null
            && nextBlockIndex !== null;
        if (hasChanges || shouldApplyBlockIndex) {
            prev.text = nextText;
            if (nextSeq !== null && (prev.seq === null || nextSeq > prev.seq)) {
                prev.seq = nextSeq;
            }
            if (shouldApplyBlockIndex) {
                prev.transcriptBlockIndex = nextBlockIndex;
            }
            prev.meta = args.meta as any;
            args.markChanged(existingId);
        }
        return { messageId: existingId, didCreate: false, accepted: true };
    }

    const mid = args.allocateId();
    const message: ReducerMessage = {
        id: mid,
        realID: args.realID,
        seq: nextSeq,
        transcriptBlockIndex: nextBlockIndex,
        localId: args.localId,
        role: 'agent',
        createdAt: args.createdAt,
        text: nextText,
        isThinking: args.isThinking,
        tool: null,
        event: null,
        meta: args.meta as any,
    };
    args.state.messages.set(mid, message);
    args.state.localIds.set(args.localId, mid);
    args.markChanged(mid);
    args.onCreate?.(message);
    return { messageId: mid, didCreate: true, accepted: true };
}
