import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { TranscriptTurn, TranscriptTurnContent } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';

export type ForkDividerTranscriptItem = ChatListItem | {
    kind: 'turn';
    id: string;
    turn: TranscriptTurn;
};

type SourceSpan = Readonly<{
    firstMessageId: string;
    lastMessageId: string;
}>;

function firstMessageIdFromTurnContent(content: TranscriptTurnContent): string | null {
    if (content.kind === 'message') return content.messageId;
    return content.toolMessageIds[0] ?? null;
}

function lastMessageIdFromTurnContent(content: TranscriptTurnContent): string | null {
    if (content.kind === 'message') return content.messageId;
    return content.toolMessageIds[content.toolMessageIds.length - 1] ?? null;
}

function getItemSourceSpan(item: ForkDividerTranscriptItem): SourceSpan | null {
    if (item.kind === 'message') {
        return { firstMessageId: item.messageId, lastMessageId: item.messageId };
    }

    if (item.kind === 'tool-calls-group') {
        const firstMessageId = item.toolMessageIds[0] ?? null;
        const lastMessageId = item.toolMessageIds[item.toolMessageIds.length - 1] ?? null;
        return firstMessageId && lastMessageId ? { firstMessageId, lastMessageId } : null;
    }

    if (item.kind === 'turn') {
        const firstContent = item.turn.content[0] ?? null;
        const lastContent = item.turn.content[item.turn.content.length - 1] ?? null;
        const firstMessageId = item.turn.userMessageId ?? (firstContent ? firstMessageIdFromTurnContent(firstContent) : null);
        const lastMessageId = lastContent ? lastMessageIdFromTurnContent(lastContent) : item.turn.userMessageId;
        return firstMessageId && lastMessageId ? { firstMessageId, lastMessageId } : null;
    }

    return null;
}

function annotateItemOrigin<T extends ForkDividerTranscriptItem>(item: T, fork: ForkedTranscriptSnapshot): T {
    if (item.kind !== 'message') return item;
    const origin = fork.messageOriginById[item.messageId];
    if (!origin) return item;
    return {
        ...item,
        originSessionId: origin.sessionId,
        isReadOnlyContext: origin.isReadOnlyContext,
    };
}

function buildDivider(params: Readonly<{
    parentSessionId: string;
    childSessionId: string;
    parentCutoffSeqInclusive: number;
}>): Extract<ChatListItem, { kind: 'fork-divider' }> {
    return {
        kind: 'fork-divider',
        id: `fork-divider:${params.parentSessionId}:${params.childSessionId}`,
        parentSessionId: params.parentSessionId,
        childSessionId: params.childSessionId,
        parentCutoffSeqInclusive: params.parentCutoffSeqInclusive,
    };
}

export function insertForkDividersIntoTranscriptItems<T extends ForkDividerTranscriptItem>(params: Readonly<{
    items: readonly T[];
    fork: ForkedTranscriptSnapshot;
}>): Array<T | Extract<ChatListItem, { kind: 'fork-divider' }>> {
    const boundaries: Array<{
        childSegmentIndex: number;
        parentSessionId: string;
        childSessionId: string;
        parentCutoffSeqInclusive: number;
    }> = [];
    const segmentIndexByMessageId = new Map<string, number>();

    params.fork.segments.forEach((segment, segmentIndex) => {
        for (const messageId of segment.messageIdsOldestFirst) {
            segmentIndexByMessageId.set(messageId, segmentIndex);
        }
    });

    for (let i = 0; i < params.fork.segments.length - 1; i += 1) {
        const parent = params.fork.segments[i]!;
        const child = params.fork.segments[i + 1]!;
        boundaries.push({
            childSegmentIndex: i + 1,
            parentSessionId: parent.sessionId,
            childSessionId: child.sessionId,
            parentCutoffSeqInclusive: parent.cutoffSeqInclusive ?? 0,
        });
    }

    const output: Array<T | Extract<ChatListItem, { kind: 'fork-divider' }>> = [];
    let boundaryIndex = 0;
    const flushBoundary = () => {
        const boundary = boundaries[boundaryIndex];
        if (!boundary) return false;
        output.push(buildDivider(boundary));
        boundaryIndex += 1;
        return true;
    };
    const flushBoundariesThroughSegment = (segmentIndex: number) => {
        while (true) {
            const boundary = boundaries[boundaryIndex];
            if (!boundary || boundary.childSegmentIndex > segmentIndex) break;
            flushBoundary();
        }
    };
    const flushRemainingBoundaries = () => {
        while (flushBoundary()) {
            // Keep empty descendant segment dividers ahead of pending/action rows.
        }
    };

    for (const item of params.items) {
        const span = getItemSourceSpan(item);
        if (span) {
            const segmentIndex = segmentIndexByMessageId.get(span.firstMessageId);
            if (segmentIndex != null) {
                flushBoundariesThroughSegment(segmentIndex);
            }
        } else if (boundaryIndex < boundaries.length) {
            flushRemainingBoundaries();
        }
        output.push(annotateItemOrigin(item, params.fork));
    }

    flushRemainingBoundaries();

    return output;
}
