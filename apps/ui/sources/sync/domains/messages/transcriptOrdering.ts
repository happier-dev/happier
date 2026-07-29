import type { Message } from './messageTypes';

export type TranscriptOrderFields = {
    id: string;
    seq?: number | null;
    createdAt: number;
    transcriptBlockIndex?: number | null;
};

export type IncomingTranscriptRowOrderFields = {
    id: string;
    seq?: number | null;
    createdAt?: number | null;
    inputIndex: number;
};

export function normalizeTranscriptSeq(seq: unknown): number | null {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
    return Math.trunc(seq);
}

export function normalizeTranscriptBlockIndex(index: unknown): number | null {
    if (typeof index !== 'number' || !Number.isFinite(index)) return null;
    const normalized = Math.trunc(index);
    return normalized >= 0 ? normalized : null;
}

export function transcriptBlockIndexFromContentIndex(contentIndex: number): number {
    return normalizeTranscriptBlockIndex(contentIndex) ?? 0;
}

export function compareTranscriptMessagesOldestFirst(
    a: TranscriptOrderFields | Message,
    b: TranscriptOrderFields | Message,
): number {
    const aSeq = normalizeTranscriptSeq(a.seq);
    const bSeq = normalizeTranscriptSeq(b.seq);
    if (aSeq !== null && bSeq !== null) {
        if (aSeq !== bSeq) return aSeq - bSeq;

        const aBlock = normalizeTranscriptBlockIndex(a.transcriptBlockIndex);
        const bBlock = normalizeTranscriptBlockIndex(b.transcriptBlockIndex);
        if (aBlock !== null && bBlock !== null && aBlock !== bBlock) {
            return aBlock - bBlock;
        }
    }

    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
    }

    const aBlock = normalizeTranscriptBlockIndex(a.transcriptBlockIndex);
    const bBlock = normalizeTranscriptBlockIndex(b.transcriptBlockIndex);
    if (aBlock !== null && bBlock !== null && aBlock !== bBlock) {
        return aBlock - bBlock;
    }

    return String(a.id).localeCompare(String(b.id));
}

function normalizeTranscriptCreatedAt(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function compareIncomingTranscriptRowsOldestFirst(
    a: IncomingTranscriptRowOrderFields,
    b: IncomingTranscriptRowOrderFields,
): number {
    const aSeq = normalizeTranscriptSeq(a.seq);
    const bSeq = normalizeTranscriptSeq(b.seq);
    if (aSeq !== null && bSeq !== null) {
        if (aSeq !== bSeq) return aSeq - bSeq;
    } else if (aSeq !== null && bSeq === null) {
        return -1;
    } else if (aSeq === null && bSeq !== null) {
        return 1;
    }

    const aCreatedAt = normalizeTranscriptCreatedAt(a.createdAt);
    const bCreatedAt = normalizeTranscriptCreatedAt(b.createdAt);
    if (aCreatedAt !== null && bCreatedAt !== null) {
        if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;
    } else if (aCreatedAt !== null && bCreatedAt === null) {
        return -1;
    } else if (aCreatedAt === null && bCreatedAt !== null) {
        return 1;
    }

    return a.inputIndex - b.inputIndex;
}

export function hasTranscriptMessageOrderChanged(
    prev: TranscriptOrderFields,
    next: TranscriptOrderFields,
): boolean {
    const prevBlockIndex = normalizeTranscriptBlockIndex(prev.transcriptBlockIndex);
    const nextBlockIndex = normalizeTranscriptBlockIndex(next.transcriptBlockIndex);

    return prev.createdAt !== next.createdAt
        || normalizeTranscriptSeq(prev.seq) !== normalizeTranscriptSeq(next.seq)
        || prevBlockIndex !== nextBlockIndex;
}
