import {
    TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    readWebPrependAnchorTestIdSuffix,
} from './webTranscriptPrependAnchor';

type AnchorIndexContentItem = Readonly<{
    kind: string;
    messageId?: string;
    toolMessageIds?: readonly string[];
}>;

type AnchorIndexTurn = Readonly<{
    userMessageId?: string | null;
    content: readonly AnchorIndexContentItem[];
}>;

type AnchorIndexItem = Readonly<{
    id: string;
    kind: string;
    messageId?: string;
    toolMessageIds?: readonly string[];
    turn?: AnchorIndexTurn;
}>;

function readStableAnchorTarget(anchorTestId: string | null | undefined): Readonly<{
    kind: 'message' | 'tool';
    id: string;
}> | null {
    const messageId = readWebPrependAnchorTestIdSuffix(
        anchorTestId,
        TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    );
    if (messageId) return { kind: 'message', id: messageId };
    const toolCallId = readWebPrependAnchorTestIdSuffix(
        anchorTestId,
        TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX,
    );
    if (toolCallId) return { kind: 'tool', id: toolCallId };
    const toolGroupId = readWebPrependAnchorTestIdSuffix(
        anchorTestId,
        TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    );
    if (toolGroupId) return { kind: 'tool', id: toolGroupId };
    return null;
}

function turnContainsTarget(
    turn: AnchorIndexTurn,
    target: NonNullable<ReturnType<typeof readStableAnchorTarget>>,
): boolean {
    if (target.kind === 'message' && turn.userMessageId === target.id) return true;
    return turn.content.some((item) => {
        if (target.kind === 'message') {
            return item.kind === 'message' && item.messageId === target.id;
        }
        return item.kind === 'tool_calls' && item.toolMessageIds?.includes(target.id) === true;
    });
}

function itemMatchesStableTarget(
    item: AnchorIndexItem,
    target: NonNullable<ReturnType<typeof readStableAnchorTarget>>,
): boolean {
    if (item.kind === 'message') {
        return target.kind === 'message' && item.messageId === target.id;
    }
    if (
        item.kind === 'tool-calls-group' ||
        item.kind === 'tool-group-header' ||
        item.kind === 'tool-group-expand' ||
        item.kind === 'tool-group-tool' ||
        item.kind === 'tool-group-footer'
    ) {
        return target.kind === 'tool' && item.toolMessageIds?.includes(target.id) === true;
    }
    if (item.kind === 'turn' && item.turn) {
        return turnContainsTarget(item.turn, target);
    }
    return false;
}

export function resolvePendingWebPrependAnchorIndex(params: Readonly<{
    anchorTestId?: string | null;
    itemTestId?: string | null;
    items: readonly AnchorIndexItem[];
}>): number | undefined {
    const target = readStableAnchorTarget(params.anchorTestId);
    if (target) {
        const index = params.items.findIndex((item) => itemMatchesStableTarget(item, target));
        if (index >= 0) return index;
    }

    const itemId = readWebPrependAnchorTestIdSuffix(
        params.itemTestId,
        TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    );
    if (!itemId) return undefined;
    const index = params.items.findIndex((item) => item.id === itemId);
    return index >= 0 ? index : undefined;
}
