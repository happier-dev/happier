type SegmentableTranscriptContentItem =
    | { kind: 'message'; messageId: string }
    | { kind: 'tool_calls'; toolMessageIds: readonly string[] }
    | { kind: string };

type SegmentableTranscriptListItem =
    | { kind: 'message'; id: string; messageId: string }
    | { kind: 'tool-calls-group'; id: string; toolMessageIds: readonly string[] }
    | { kind: 'pending-queue'; id: string }
    | { kind: 'action-draft'; id: string }
    | { kind: 'turn'; id: string; turn: { userMessageId?: string | null; content: readonly SegmentableTranscriptContentItem[] } }
    | { kind: string; id: string };

function isMessageContentItem(
    item: SegmentableTranscriptContentItem,
): item is Extract<SegmentableTranscriptContentItem, { kind: 'message' }> {
    return item.kind === 'message';
}

function isToolCallsContentItem(
    item: SegmentableTranscriptContentItem,
): item is Extract<SegmentableTranscriptContentItem, { kind: 'tool_calls' }> {
    return item.kind === 'tool_calls';
}

export function buildTranscriptHotColdSegments<T extends SegmentableTranscriptListItem>(params: Readonly<{
    enabled: boolean;
    hotTailItemCount: number;
    items: readonly T[];
    activeThinkingMessageId: string | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
}>): { coldItems: T[]; hotItems: T[]; splitIndex: number } {
    const items = Array.isArray(params.items) ? params.items : [];
    if (!params.enabled || items.length === 0) {
        return {
            coldItems: [...items],
            hotItems: [],
            splitIndex: items.length,
        };
    }

    if (items.length === 1) {
        return {
            coldItems: [...items],
            hotItems: [],
            splitIndex: 1,
        };
    }

    const normalizedHotTailItemCount =
        typeof params.hotTailItemCount === 'number' && Number.isFinite(params.hotTailItemCount)
            ? Math.max(1, Math.trunc(params.hotTailItemCount))
            : 1;
    const trailingHotStartIndex = Math.max(0, items.length - normalizedHotTailItemCount);
    let splitIndex = trailingHotStartIndex;

    for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.kind === 'message') {
            if (item.messageId === params.activeThinkingMessageId) {
                splitIndex = Math.min(splitIndex, index);
            }
            continue;
        }

        if (item.kind === 'tool-calls-group') {
            if (item.toolMessageIds.some((id: string) => params.expandedToolCallsAnchorMessageIds.has(id))) {
                splitIndex = Math.min(splitIndex, index);
            }
            continue;
        }

        if (item.kind === 'pending-queue' || item.kind === 'action-draft') {
            splitIndex = Math.min(splitIndex, index);
            continue;
        }

        if (item.kind === 'turn') {
            if (item.turn.userMessageId && item.turn.userMessageId === params.activeThinkingMessageId) {
                splitIndex = Math.min(splitIndex, index);
                continue;
            }

            const keepsTurnHot = item.turn.content.some((contentItem: SegmentableTranscriptContentItem) => {
                if (isMessageContentItem(contentItem)) {
                    return contentItem.messageId === params.activeThinkingMessageId;
                }
                if (isToolCallsContentItem(contentItem)) {
                    return contentItem.toolMessageIds.some((id: string) => params.expandedToolCallsAnchorMessageIds.has(id));
                }
                return false;
            });
            if (keepsTurnHot) {
                splitIndex = Math.min(splitIndex, index);
            }
        }
    }

    // Ensure the cold segment is never empty. Keeping at least one cold item avoids rendering
    // the entire transcript in a footer-only block (which breaks index-based scroll operations).
    splitIndex = Math.max(1, Math.min(splitIndex, items.length - 1));

    return {
        coldItems: items.slice(0, splitIndex),
        hotItems: items.slice(splitIndex),
        splitIndex,
    };
}
