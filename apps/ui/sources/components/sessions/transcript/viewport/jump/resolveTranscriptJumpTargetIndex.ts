import type {
    TranscriptJumpTarget,
    TranscriptJumpTargetIndexResult,
    TranscriptJumpTargetRole,
} from './transcriptJumpTargetTypes';

export type TranscriptJumpTargetResolvableItem = Readonly<Record<string, unknown>>;

type ResolvedAnchor = Readonly<{
    index: number;
    seq: number | null;
    routeMessageId: string | null;
    transcriptBlockIndex: number | null;
    role: TranscriptJumpTargetRole | null;
}>;

type NearestAnchor = Readonly<{
    index: number;
    seq: number;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function normalizeString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeRole(value: unknown): TranscriptJumpTargetRole | null {
    if (
        value === 'user' ||
        value === 'assistant' ||
        value === 'tool' ||
        value === 'system' ||
        value === 'unknown'
    ) {
        return value;
    }
    return null;
}

function resolveMessageSeq(
    messageId: unknown,
    resolveSeqForMessageId: (messageId: string) => number | null | undefined,
): number | null {
    const normalizedMessageId = normalizeString(messageId);
    if (!normalizedMessageId) return null;
    return normalizeSeq(resolveSeqForMessageId(normalizedMessageId));
}

function resolveMessageRouteId(
    messageId: unknown,
    resolveRouteMessageIdForMessageId: ((messageId: string) => string | null | undefined) | undefined,
): string | null {
    const normalizedMessageId = normalizeString(messageId);
    if (!normalizedMessageId || !resolveRouteMessageIdForMessageId) return null;
    return normalizeString(resolveRouteMessageIdForMessageId(normalizedMessageId));
}

function resolveMessageTranscriptBlockIndex(
    messageId: unknown,
    resolveTranscriptBlockIndexForMessageId: ((messageId: string) => number | null | undefined) | undefined,
): number | null {
    const normalizedMessageId = normalizeString(messageId);
    if (!normalizedMessageId || !resolveTranscriptBlockIndexForMessageId) return null;
    return normalizeSeq(resolveTranscriptBlockIndexForMessageId(normalizedMessageId));
}

function resolveMessageRole(
    messageId: unknown,
    resolveRoleForMessageId: ((messageId: string) => TranscriptJumpTargetRole | null | undefined) | undefined,
): TranscriptJumpTargetRole | null {
    const normalizedMessageId = normalizeString(messageId);
    if (!normalizedMessageId || !resolveRoleForMessageId) return null;
    return normalizeRole(resolveRoleForMessageId(normalizedMessageId));
}

function pushAnchor(params: {
    anchors: ResolvedAnchor[];
    index: number;
    messageId: unknown;
    seq: unknown;
    routeMessageId: unknown;
    transcriptBlockIndex: unknown;
    role: unknown;
    resolveSeqForMessageId: (messageId: string) => number | null | undefined;
    resolveRouteMessageIdForMessageId?: (messageId: string) => string | null | undefined;
    resolveTranscriptBlockIndexForMessageId?: (messageId: string) => number | null | undefined;
    resolveRoleForMessageId?: (messageId: string) => TranscriptJumpTargetRole | null | undefined;
}) {
    const seq = normalizeSeq(params.seq) ?? resolveMessageSeq(params.messageId, params.resolveSeqForMessageId);
    const routeMessageId =
        normalizeString(params.routeMessageId)
        ?? resolveMessageRouteId(params.messageId, params.resolveRouteMessageIdForMessageId);
    const transcriptBlockIndex =
        normalizeSeq(params.transcriptBlockIndex)
        ?? resolveMessageTranscriptBlockIndex(params.messageId, params.resolveTranscriptBlockIndexForMessageId);
    const role =
        normalizeRole(params.role)
        ?? resolveMessageRole(params.messageId, params.resolveRoleForMessageId);

    if (seq == null && routeMessageId == null) return;
    params.anchors.push({ index: params.index, seq, routeMessageId, transcriptBlockIndex, role });
}

function collectAnchors(params: Readonly<{
    items: readonly TranscriptJumpTargetResolvableItem[];
    resolveSeqForMessageId: (messageId: string) => number | null | undefined;
    resolveRouteMessageIdForMessageId?: (messageId: string) => string | null | undefined;
    resolveTranscriptBlockIndexForMessageId?: (messageId: string) => number | null | undefined;
    resolveRoleForMessageId?: (messageId: string) => TranscriptJumpTargetRole | null | undefined;
}>): ResolvedAnchor[] {
    const anchors: ResolvedAnchor[] = [];

    for (let index = 0; index < params.items.length; index++) {
        const item = params.items[index]!;
        const kind = normalizeString(item.kind);
        if (kind === 'message') {
            pushAnchor({
                anchors,
                index,
                messageId: item.messageId,
                seq: item.seq,
                routeMessageId: item.routeMessageId,
                transcriptBlockIndex: item.transcriptBlockIndex,
                role: item.role,
                resolveSeqForMessageId: params.resolveSeqForMessageId,
                resolveRouteMessageIdForMessageId: params.resolveRouteMessageIdForMessageId,
                resolveTranscriptBlockIndexForMessageId: params.resolveTranscriptBlockIndexForMessageId,
                resolveRoleForMessageId: params.resolveRoleForMessageId,
            });
            continue;
        }

        if (kind === 'tool-group-tool') {
            pushAnchor({
                anchors,
                index,
                messageId: item.toolMessageId,
                seq: item.seq,
                routeMessageId: item.routeMessageId,
                transcriptBlockIndex: item.transcriptBlockIndex,
                role: item.role,
                resolveSeqForMessageId: params.resolveSeqForMessageId,
                resolveRouteMessageIdForMessageId: params.resolveRouteMessageIdForMessageId,
                resolveTranscriptBlockIndexForMessageId: params.resolveTranscriptBlockIndexForMessageId,
                resolveRoleForMessageId: params.resolveRoleForMessageId,
            });
            continue;
        }

        if (kind !== 'turn' || !isRecord(item.turn)) continue;

        pushAnchor({
            anchors,
            index,
            messageId: item.turn.userMessageId,
            seq: item.turn.userSeq,
            routeMessageId: item.turn.userRouteMessageId,
            transcriptBlockIndex: item.turn.userTranscriptBlockIndex,
            role: item.turn.userRole,
            resolveSeqForMessageId: params.resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId: params.resolveRouteMessageIdForMessageId,
            resolveTranscriptBlockIndexForMessageId: params.resolveTranscriptBlockIndexForMessageId,
            resolveRoleForMessageId: params.resolveRoleForMessageId,
        });

        const content = Array.isArray(item.turn.content) ? item.turn.content : [];
        for (const entry of content) {
            if (!isRecord(entry)) continue;
            const entryKind = normalizeString(entry.kind);
            if (entryKind === 'message') {
                pushAnchor({
                    anchors,
                    index,
                    messageId: entry.messageId,
                    seq: entry.seq,
                    routeMessageId: entry.routeMessageId,
                    transcriptBlockIndex: entry.transcriptBlockIndex,
                    role: entry.role,
                    resolveSeqForMessageId: params.resolveSeqForMessageId,
                    resolveRouteMessageIdForMessageId: params.resolveRouteMessageIdForMessageId,
                    resolveTranscriptBlockIndexForMessageId: params.resolveTranscriptBlockIndexForMessageId,
                    resolveRoleForMessageId: params.resolveRoleForMessageId,
                });
            } else if (entryKind === 'tool_calls' && Array.isArray(entry.toolMessageIds)) {
                for (const toolMessageId of entry.toolMessageIds) {
                    pushAnchor({
                        anchors,
                        index,
                        messageId: toolMessageId,
                        seq: null,
                        routeMessageId: null,
                        transcriptBlockIndex: null,
                        role: null,
                        resolveSeqForMessageId: params.resolveSeqForMessageId,
                        resolveRouteMessageIdForMessageId: params.resolveRouteMessageIdForMessageId,
                        resolveTranscriptBlockIndexForMessageId: params.resolveTranscriptBlockIndexForMessageId,
                        resolveRoleForMessageId: params.resolveRoleForMessageId,
                    });
                }
            }
        }
    }

    return anchors;
}

function resolveBySeq(params: Readonly<{
    targetSeq: number;
    anchors: readonly ResolvedAnchor[];
    exactIsFound: boolean;
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
}>): TranscriptJumpTargetIndexResult {
    let exact: ResolvedAnchor | null = null;
    let nextAfter: NearestAnchor | null = null;
    let prevBefore: NearestAnchor | null = null;

    for (const anchor of params.anchors) {
        if (anchor.seq == null) continue;
        if (anchor.seq === params.targetSeq) {
            exact = anchor;
            break;
        }
        if (anchor.seq > params.targetSeq) {
            if (!nextAfter || anchor.seq < nextAfter.seq) {
                nextAfter = { index: anchor.index, seq: anchor.seq };
            }
        } else if (anchor.seq < params.targetSeq) {
            if (!prevBefore || anchor.seq > prevBefore.seq) {
                prevBefore = { index: anchor.index, seq: anchor.seq };
            }
        }
    }

    if (exact) {
        return params.exactIsFound
            ? {
                status: 'found',
                index: exact.index,
                seq: exact.seq,
                routeMessageId: exact.routeMessageId,
            }
            : {
                status: 'nearest',
                index: exact.index,
                seq: params.targetSeq,
                targetSeq: params.targetSeq,
            };
    }

    if (nextAfter && prevBefore === null) {
        if (params.hasMoreOlder) {
            return {
                status: 'unresolved',
                direction: 'older',
                targetSeq: params.targetSeq,
                nearestIndex: nextAfter.index,
                nearestSeq: nextAfter.seq,
            };
        }
        return { status: 'nearest', index: nextAfter.index, seq: nextAfter.seq, targetSeq: params.targetSeq };
    }

    if (prevBefore && nextAfter === null) {
        if (params.hasMoreNewer) {
            return {
                status: 'unresolved',
                direction: 'newer',
                targetSeq: params.targetSeq,
                nearestIndex: prevBefore.index,
                nearestSeq: prevBefore.seq,
            };
        }
        return { status: 'nearest', index: prevBefore.index, seq: prevBefore.seq, targetSeq: params.targetSeq };
    }

    if (nextAfter) {
        return { status: 'nearest', index: nextAfter.index, seq: nextAfter.seq, targetSeq: params.targetSeq };
    }
    if (prevBefore) {
        return { status: 'nearest', index: prevBefore.index, seq: prevBefore.seq, targetSeq: params.targetSeq };
    }
    return { status: 'not-found', reason: 'unavailable' };
}

function routeTargetMatchesAnchor(
    target: Extract<TranscriptJumpTarget, { kind: 'route-message-id' }>,
    anchor: ResolvedAnchor,
): boolean {
    if (anchor.routeMessageId !== target.routeMessageId) return false;
    const targetBlockIndex = normalizeSeq(target.transcriptBlockIndex);
    if (targetBlockIndex !== null && anchor.transcriptBlockIndex !== targetBlockIndex) {
        return false;
    }
    const targetRole = normalizeRole(target.role);
    if (targetRole !== null && anchor.role !== targetRole) {
        return false;
    }
    return true;
}

export function resolveTranscriptJumpTargetIndex(params: Readonly<{
    target: TranscriptJumpTarget;
    items: readonly TranscriptJumpTargetResolvableItem[];
    resolveSeqForMessageId: (messageId: string) => number | null | undefined;
    resolveRouteMessageIdForMessageId?: (messageId: string) => string | null | undefined;
    resolveTranscriptBlockIndexForMessageId?: (messageId: string) => number | null | undefined;
    resolveRoleForMessageId?: (messageId: string) => TranscriptJumpTargetRole | null | undefined;
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
}>): TranscriptJumpTargetIndexResult {
    const targetSeq = params.target.kind === 'seq'
        ? normalizeSeq(params.target.seq)
        : normalizeSeq(params.target.seqHint);
    if (params.target.kind === 'seq' && targetSeq == null) {
        return { status: 'not-found', reason: 'invalid-target' };
    }
    if (params.target.kind === 'route-message-id' && normalizeString(params.target.routeMessageId) == null) {
        return { status: 'not-found', reason: 'invalid-target' };
    }

    const anchors = collectAnchors(params);

    if (params.target.kind === 'route-message-id') {
        for (const anchor of anchors) {
            if (routeTargetMatchesAnchor(params.target, anchor)) {
                return {
                    status: 'found',
                    index: anchor.index,
                    seq: anchor.seq,
                    routeMessageId: anchor.routeMessageId,
                };
            }
        }
        if (targetSeq == null) return { status: 'not-found', reason: 'unavailable' };
        const seqResult = resolveBySeq({
            targetSeq,
            anchors,
            exactIsFound: false,
            hasMoreOlder: params.hasMoreOlder,
            hasMoreNewer: params.hasMoreNewer,
        });
        return seqResult.status === 'nearest'
            ? { status: 'not-found', reason: 'unavailable' }
            : seqResult;
    }

    if (targetSeq == null) return { status: 'not-found', reason: 'invalid-target' };
    return resolveBySeq({
        targetSeq,
        anchors,
        exactIsFound: params.target.kind === 'seq',
        hasMoreOlder: params.hasMoreOlder,
        hasMoreNewer: params.hasMoreNewer,
    });
}

export function resolveTranscriptJumpSeqIndex(params: Readonly<{
    targetSeq: number;
    items: readonly TranscriptJumpTargetResolvableItem[];
    resolveSeqForMessageId: (messageId: string) => number | null | undefined;
    hasMoreOlder: boolean;
}>): number | null {
    const result = resolveTranscriptJumpTargetIndex({
        target: { kind: 'seq', seq: params.targetSeq },
        items: params.items,
        resolveSeqForMessageId: params.resolveSeqForMessageId,
        hasMoreOlder: params.hasMoreOlder,
        hasMoreNewer: false,
    });

    return result.status === 'found' || result.status === 'nearest'
        ? result.index
        : null;
}
