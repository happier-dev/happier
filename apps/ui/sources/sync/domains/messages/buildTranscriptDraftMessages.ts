import type { Message } from './messageTypes';

type TranscriptDraftRecord = Readonly<{
    text: string;
    segmentKind: 'assistant' | 'thinking';
    sidechainId: string | null;
    updatedAtMs: number;
}>;

function normalizeSidechainId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeUpdatedAtMs(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function buildTranscriptDraftMessages(params: Readonly<{
    draftsByLocalId: Readonly<Record<string, TranscriptDraftRecord>>;
    sidechainId?: string | null;
}>): Message[] {
    const chainSidechainId = normalizeSidechainId(params.sidechainId);
    const out: Message[] = [];

    for (const [localId, draft] of Object.entries(params.draftsByLocalId)) {
        if (!draft || typeof draft.text !== 'string' || draft.text.length === 0) continue;
        const draftSidechainId = normalizeSidechainId(draft.sidechainId);
        if (draftSidechainId !== chainSidechainId) continue;

        const normalizedLocalId = localId.trim();
        if (!normalizedLocalId) continue;

        out.push({
            kind: 'agent-text',
            id: `draft:${chainSidechainId ?? 'main'}:${normalizedLocalId}`,
            realID: null,
            localId: normalizedLocalId,
            createdAt: normalizeUpdatedAtMs(draft.updatedAtMs),
            text: draft.text,
            isThinking: draft.segmentKind === 'thinking',
            meta: {
                happierTransientDraftV1: {
                    localId: normalizedLocalId,
                    sidechainId: chainSidechainId,
                },
            },
        });
    }

    out.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return String(a.id).localeCompare(String(b.id));
    });
    return out;
}
