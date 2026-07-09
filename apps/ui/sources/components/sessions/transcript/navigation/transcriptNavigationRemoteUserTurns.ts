import type { UserMessageHistoryRemoteEntry } from '@/sync/engine/sessions/fetchUserMessageHistoryPage';

import type {
    TranscriptNavigationLoadedMessage,
    TranscriptNavigationRemoteUserTurn,
} from './transcriptNavigationTypes';

export function resolveTranscriptNavigationRemoteUserTurnBeforeSeq(
    loadedMessages: readonly TranscriptNavigationLoadedMessage[],
): number | null {
    let earliestSeq: number | null = null;
    for (const message of loadedMessages) {
        if (message.role !== 'user') continue;
        const seq = typeof message.seq === 'number' && Number.isFinite(message.seq)
            ? Math.trunc(message.seq)
            : null;
        if (seq === null || seq < 0) continue;
        earliestSeq = earliestSeq === null ? seq : Math.min(earliestSeq, seq);
    }
    return earliestSeq;
}

export function deriveTranscriptNavigationRemoteUserTurns(params: Readonly<{
    sessionId: string;
    beforeSeq: number | null;
    entries: readonly UserMessageHistoryRemoteEntry[];
}>): TranscriptNavigationRemoteUserTurn[] {
    const beforeSeq = typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq)
        ? Math.trunc(params.beforeSeq)
        : null;
    const out: TranscriptNavigationRemoteUserTurn[] = [];
    const seenSeqs = new Set<number>();

    for (const entry of params.entries) {
        const seq = typeof entry.seq === 'number' && Number.isFinite(entry.seq)
            ? Math.trunc(entry.seq)
            : null;
        if (seq === null || seq < 0) continue;
        if (beforeSeq !== null && seq >= beforeSeq) continue;
        if (seenSeqs.has(seq)) continue;

        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        if (!text) continue;

        seenSeqs.add(seq);
        out.push({
            sessionId: params.sessionId,
            seq,
            text,
            createdAtMs: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
                ? Math.trunc(entry.createdAt)
                : null,
        });
    }

    return out;
}
