import type { SessionViewportAnchorSnapshot } from '@/sync/sync';

type TranscriptViewportAnchorMessageContent = Readonly<
    | {
        kind: 'message';
        messageId?: unknown;
    }
    | {
        kind: 'tool_calls';
        toolMessageIds?: unknown;
    }
>;

type TranscriptViewportAnchorTurn = Readonly<{
    userMessageId?: unknown;
    content?: unknown;
}>;

export type TranscriptViewportAnchorResolvableItem = Readonly<{
    id?: unknown;
    kind?: unknown;
    messageId?: unknown;
    seq?: unknown;
    toolMessageId?: unknown;
    toolMessageIds?: unknown;
    turn?: TranscriptViewportAnchorTurn;
}>;

export type TranscriptViewportAnchorLookupFailureReason =
    | 'not-hydrated'
    | 'not-in-window'
    | 'pruned'
    | 'fork-boundary'
    | 'deleted-missing';

export type TranscriptViewportAnchorLookupResult = Readonly<
    | { status: 'found'; index: number }
    | { status: 'missing'; reason: TranscriptViewportAnchorLookupFailureReason }
>;

export function resolveTranscriptViewportAnchorFocusOffsetPx(viewportHeightPx: number): number {
    const preferred = Math.round(viewportHeightPx * 0.18);
    return Math.max(64, Math.min(128, preferred));
}

/**
 * Pass 1 (exact ownership): rows that RENDER the anchored message themselves.
 * Per-unit tool rows own exactly their `toolMessageId`; header/expand/footer caps never
 * own a message — they participate only in the containment fallback (pass 2), which
 * covers tools hidden behind a collapsed preview.
 */
function itemOwnsMessageId(item: TranscriptViewportAnchorResolvableItem, messageId: string): boolean {
    if (item.kind === 'message') {
        return item.messageId === messageId;
    }
    if (item.kind === 'tool-group-tool') {
        return item.toolMessageId === messageId;
    }
    if (item.kind === 'tool-calls-group') {
        return Array.isArray(item.toolMessageIds) && item.toolMessageIds.includes(messageId);
    }
    if (item.kind !== 'turn') return false;

    const turn = item.turn;
    if (turn?.userMessageId === messageId) return true;
    const content = Array.isArray(turn?.content) ? turn.content : [];
    return content.some((entry: TranscriptViewportAnchorMessageContent) => {
        if (entry.kind === 'message') {
            return entry.messageId === messageId;
        }
        if (entry.kind === 'tool_calls') {
            return Array.isArray(entry.toolMessageIds) && entry.toolMessageIds.includes(messageId);
        }
        return false;
    });
}

export function resolveTranscriptViewportAnchorIndex(params: Readonly<{
    anchor: Pick<SessionViewportAnchorSnapshot, 'messageId' | 'itemId' | 'seq'>;
    items: readonly TranscriptViewportAnchorResolvableItem[];
}>): number | null {
    const messageId = typeof params.anchor.messageId === 'string' && params.anchor.messageId.length > 0
        ? params.anchor.messageId
        : null;
    if (messageId) {
        // Two-pass resolution (N2c): exact message-owning rows win over containment so a
        // visible per-unit tool row beats its group's header cap.
        const owningIndex = params.items.findIndex((item) => itemOwnsMessageId(item, messageId));
        if (owningIndex >= 0) return owningIndex;
        const containingIndex = params.items.findIndex((item) => headerUnitContainsMessageId(item, messageId));
        if (containingIndex >= 0) return containingIndex;
    }

    const itemIndex = params.items.findIndex((item) => item.id === params.anchor.itemId);
    if (itemIndex >= 0) return itemIndex;

    const anchorSeq = normalizeSeq(params.anchor.seq);
    if (anchorSeq == null) return null;
    const seqIndex = params.items.findIndex((item) => normalizeSeq(item.seq) === anchorSeq);
    return seqIndex >= 0 ? seqIndex : null;
}

export function resolveTranscriptViewportAnchorLookup(params: Readonly<{
    anchor: Pick<SessionViewportAnchorSnapshot, 'messageId' | 'itemId' | 'seq'>;
    items: readonly TranscriptViewportAnchorResolvableItem[];
    canMaterializeOlder?: boolean;
    forkBoundarySeq?: number | null;
    hydrationState?: 'hydrated' | 'not-hydrated';
    materializedSeqRange?: Readonly<{ minSeq: number; maxSeq: number }> | null;
}>): TranscriptViewportAnchorLookupResult {
    const index = resolveTranscriptViewportAnchorIndex({
        anchor: params.anchor,
        items: params.items,
    });
    if (index != null) return { status: 'found', index };

    if (params.hydrationState === 'not-hydrated') {
        return { status: 'missing', reason: 'not-hydrated' };
    }

    const anchorSeq = normalizeSeq(params.anchor.seq);
    if (anchorSeq == null) {
        return { status: 'missing', reason: 'deleted-missing' };
    }

    const forkBoundarySeq = normalizeSeq(params.forkBoundarySeq);
    if (forkBoundarySeq != null && anchorSeq <= forkBoundarySeq) {
        return { status: 'missing', reason: 'fork-boundary' };
    }

    const range = params.materializedSeqRange;
    const minSeq = normalizeSeq(range?.minSeq);
    const maxSeq = normalizeSeq(range?.maxSeq);
    if (minSeq != null && anchorSeq < minSeq) {
        return {
            status: 'missing',
            reason: params.canMaterializeOlder === true ? 'not-in-window' : 'pruned',
        };
    }
    if (maxSeq != null && anchorSeq > maxSeq) {
        return { status: 'missing', reason: 'not-in-window' };
    }

    return { status: 'missing', reason: 'deleted-missing' };
}

/** Pass 2 (containment): the header cap stands in for tools without an own row (collapsed/hidden). */
function headerUnitContainsMessageId(item: TranscriptViewportAnchorResolvableItem, messageId: string): boolean {
    if (item.kind !== 'tool-group-header') return false;
    return Array.isArray(item.toolMessageIds) && item.toolMessageIds.includes(messageId);
}

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

export function resolveTranscriptViewportAnchorDescriptor(
    item: TranscriptViewportAnchorResolvableItem,
): Pick<SessionViewportAnchorSnapshot, 'kind' | 'messageId' | 'itemId'> | null {
    if (typeof item.id !== 'string' || item.id.length === 0) return null;

    if (item.kind === 'message' && typeof item.messageId === 'string' && item.messageId.length > 0) {
        return {
            kind: 'message',
            itemId: item.id,
            messageId: item.messageId,
        };
    }

    if (item.kind === 'tool-group-tool' && typeof item.toolMessageId === 'string' && item.toolMessageId.length > 0) {
        return {
            kind: 'message',
            itemId: item.id,
            messageId: item.toolMessageId,
        };
    }

    if (
        item.kind === 'tool-calls-group' ||
        item.kind === 'tool-group-header' ||
        item.kind === 'tool-group-expand' ||
        item.kind === 'tool-group-footer'
    ) {
        const messageId = Array.isArray(item.toolMessageIds) && typeof item.toolMessageIds[0] === 'string'
            ? item.toolMessageIds[0]
            : null;
        return {
            kind: 'toolGroup',
            itemId: item.id,
            messageId,
        };
    }

    if (item.kind === 'turn') {
        const turn = item.turn;
        if (typeof turn?.userMessageId === 'string' && turn.userMessageId.length > 0) {
            return {
                kind: 'message',
                itemId: item.id,
                messageId: turn.userMessageId,
            };
        }
        const content = Array.isArray(turn?.content) ? turn.content : [];
        for (const entry of content as TranscriptViewportAnchorMessageContent[]) {
            if (entry.kind === 'message' && typeof entry.messageId === 'string' && entry.messageId.length > 0) {
                return {
                    kind: 'message',
                    itemId: item.id,
                    messageId: entry.messageId,
                };
            }
            if (entry.kind === 'tool_calls' && Array.isArray(entry.toolMessageIds) && typeof entry.toolMessageIds[0] === 'string') {
                return {
                    kind: 'toolGroup',
                    itemId: item.id,
                    messageId: entry.toolMessageIds[0],
                };
            }
        }
    }

    return {
        kind: 'item',
        itemId: item.id,
        messageId: null,
    };
}
