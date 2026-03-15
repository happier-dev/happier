import type { NormalizedMessage } from '@/sync/typesRaw';

function normalizeSeq(seq: unknown): number | null {
    return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
}

export function sortNormalizedMessagesOldestFirst(messages: NormalizedMessage[]): void {
    messages.sort((a, b) => {
        const aSeq = normalizeSeq((a as any).seq);
        const bSeq = normalizeSeq((b as any).seq);
        if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;

        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return String(a.id).localeCompare(String(b.id));
    });
}
