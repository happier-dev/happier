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
    // Comparing mixed sequenced/unsequenced pairs by time makes the comparator
    // non-transitive, which can leave incremental transcript merges out of order.
    if (aSeq !== null && bSeq !== null) {
        if (aSeq !== bSeq) return aSeq - bSeq;

        const aBlock = normalizeTranscriptBlockIndex(a.transcriptBlockIndex);
        const bBlock = normalizeTranscriptBlockIndex(b.transcriptBlockIndex);
        if (aBlock !== null && bBlock !== null && aBlock !== bBlock) {
            return aBlock - bBlock;
        }
    } else if (aSeq !== null) {
        return -1;
    } else if (bSeq !== null) {
        return 1;
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


/** AgentState requests are timeline projections, not new committed records. */
function isPermissionProjection(message: (TranscriptOrderFields & {
    kind?: Message['kind'];
    tool?: { permission?: unknown };
}) | undefined): boolean {
    return message?.kind === 'tool-call'
        && normalizeTranscriptSeq(message.seq) === null
        && Boolean(message.tool?.permission);
}

/**
 * Keep the committed sequence backbone intact and place request projections by
 * their original time. Mixing those two rules in a pairwise comparator creates
 * cycles when clocks disagree; placement therefore needs the materialized list.
 */
function placePermissionProjections<T>(
    ordinary: readonly T[],
    projections: readonly T[],
    read: (row: T) => Message | undefined,
): T[] {
    if (projections.length === 0) return ordinary.slice();
    const result: T[] = [];
    let next = 0;
    for (const row of ordinary) {
        const message = read(row);
        while (next < projections.length) {
            const projection = read(projections[next]!);
            if (message && projection && projection.createdAt >= message.createdAt) break;
            result.push(projections[next++]!);
        }
        result.push(row);
    }
    while (next < projections.length) result.push(projections[next++]!);
    return result;
}

export function sortTranscriptMessagesOldestFirst<T extends Message>(messages: readonly T[]): T[] {
    const sorted = [...messages].sort(compareTranscriptMessagesOldestFirst);
    const ordinary: T[] = [];
    const projections: T[] = [];
    for (const message of sorted) {
        (isPermissionProjection(message) ? projections : ordinary).push(message);
    }
    return placePermissionProjections(ordinary, projections, message => message);
}

/** Incremental counterpart of the same list-level ordering; text edits never call it. */
export function mergeTranscriptMessageIdsOldestFirst(
    existingSortedIds: readonly string[],
    insertSortedIds: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
): { messageIdsOldestFirst: string[]; appendOnly: boolean } {
    const read = (id: string) => messagesById[id];
    const compare = (a: string, b: string) => {
        if (a === b) return 0;
        const left = read(a);
        const right = read(b);
        if (!left && !right) return a.localeCompare(b);
        if (!left) return -1;
        if (!right) return 1;
        return compareTranscriptMessagesOldestFirst(left, right);
    };
    const last = existingSortedIds[existingSortedIds.length - 1];
    const first = insertSortedIds[0];
    if (!insertSortedIds.some(id => isPermissionProjection(read(id)))
        && (existingSortedIds.length === 0 || insertSortedIds.length === 0
            || (last !== undefined && first !== undefined && compare(last, first) <= 0))) {
        return { messageIdsOldestFirst: [...existingSortedIds, ...insertSortedIds], appendOnly: true };
    }

    const existing: string[] = [];
    const existingProjections: string[] = [];
    const incoming: string[] = [];
    const incomingProjections: string[] = [];
    for (const id of existingSortedIds) {
        (isPermissionProjection(read(id)) ? existingProjections : existing).push(id);
    }
    for (const id of insertSortedIds) {
        (isPermissionProjection(read(id)) ? incomingProjections : incoming).push(id);
    }
    const merge = (left: readonly string[], right: readonly string[]) => {
        const result: string[] = [];
        const seen = new Set<string>();
        let i = 0;
        let j = 0;
        while (i < left.length || j < right.length) {
            const a = left[i];
            const b = right[j];
            const id = a === undefined ? b! : b === undefined ? a : compare(a, b) <= 0 ? a : b;
            if (!seen.has(id)) {
                result.push(id);
                seen.add(id);
            }
            if (id === a) i++;
            if (id === b) j++;
        }
        return result;
    };
    return { messageIdsOldestFirst: placePermissionProjections(
        merge(existing, incoming),
        merge(existingProjections, incomingProjections),
        read,
    ), appendOnly: false };
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
        || prevBlockIndex !== nextBlockIndex
        || isPermissionProjection(prev) !== isPermissionProjection(next);
}
