import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import type { Message } from '@/sync/domains/messages/messageTypes';

import type {
    TranscriptItemHeightRowState,
    TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';

const TRANSCRIPT_ROW_TYPE_LONG_TEXT_MIN_CHARS = 512;
const TRANSCRIPT_COLLAPSED_TOOL_GROUP_SIGNATURE_PREVIEW_COUNT = 15;

export type TranscriptRowShellItem =
    | ChatListItem
    | {
        kind: 'turn';
        id: string;
        turn: TranscriptTurn;
    };

export function resolveTranscriptRowItemType(params: Readonly<{
    activeThinkingMessageId: string | null;
    getMessageById: (messageId: string) => Message | null;
    item: TranscriptRowShellItem;
}>): string {
    const { item } = params;
    if (item.kind === 'message') {
        return resolveMessageRowType(params.getMessageById(item.messageId), params.activeThinkingMessageId);
    }
    if (item.kind === 'tool-calls-group') return 'tool-group';
    if (item.kind === 'pending-queue') return 'pending-action';
    if (item.kind === 'action-draft') return 'pending-action';
    if (item.kind === 'fork-divider') return 'fork-divider';
    if (item.kind === 'turn') {
        if (item.turn.content.some((content) => content.kind === 'tool_calls')) return 'turn:tool';
        const messageIds = collectMessageIdsFromTurn(item.turn);
        if (messageIds.some((messageId) => {
            const message = params.getMessageById(messageId);
            return message?.kind === 'agent-text' && (message.isThinking === true || message.id === params.activeThinkingMessageId);
        })) {
            return 'turn:thinking';
        }
        return 'turn:text';
    }
    return 'message:agent-short';
}

export function buildTranscriptRowShellSignature(params: Readonly<{
    activeThinkingMessageId: string | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null;
    getMessageById: (messageId: string) => Message | null;
    groupingMode: string;
    item: TranscriptRowShellItem;
    latestCommittedActivityKey: string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    sessionActive: boolean;
    widthBucket: string;
    fontScaleKey: string;
}>): TranscriptItemHeightValiditySignature {
    const item = params.item;
    const base = {
        itemId: item.id,
        kind: resolveTranscriptRowItemType({
            activeThinkingMessageId: params.activeThinkingMessageId,
            getMessageById: params.getMessageById,
            item,
        }),
        widthBucket: params.widthBucket,
        fontScaleKey: params.fontScaleKey,
        groupingMode: params.groupingMode || 'linear',
        forkContextKey: resolveForkContextKeyForItem(item, params.forkMessageMetadataById),
    } as const;

    if (item.kind === 'message') {
        const message = params.getMessageById(item.messageId);
        return {
            ...base,
            structuralKey: buildMessageShellStructuralKey(item.messageId, message),
            expansionKey: [
                'tools:none',
                buildThinkingExpansionKey({
                    getMessageById: params.getMessageById,
                    messageIds: [item.messageId],
                    resolveThinkingExpanded: params.resolveThinkingExpanded,
                }),
            ].join('|'),
            rowState: resolveMessageRowState({
                activeThinkingMessageId: params.activeThinkingMessageId,
                isLatestCommittedActivity: item.messageId === params.latestCommittedActivityKey,
                message,
                sessionActive: params.sessionActive,
            }),
        };
    }

    if (item.kind === 'tool-calls-group') {
        const messageStates = item.toolMessageIds.map((messageId) => resolveMessageRowState({
            activeThinkingMessageId: params.activeThinkingMessageId,
            isLatestCommittedActivity: messageId === params.latestCommittedActivityKey,
            message: params.getMessageById(messageId),
            sessionActive: params.sessionActive,
        }));
        return {
            ...base,
            structuralKey: buildToolGroupShellStructuralKey({
                id: item.id,
                getMessageById: params.getMessageById,
                expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
                toolMessageIds: item.toolMessageIds,
            }),
            expansionKey: [
                buildToolExpansionKey(item.toolMessageIds, params.expandedToolCallsAnchorMessageIds),
                'thinking:none',
            ].join('|'),
            rowState: messageStates.includes('tool-progress') ? 'tool-progress' : 'stable',
        };
    }

    if (item.kind === 'turn') {
        const messageIds = collectMessageIdsFromTurn(item.turn);
        const messageStates = messageIds.map((messageId) => resolveMessageRowState({
            activeThinkingMessageId: params.activeThinkingMessageId,
            isLatestCommittedActivity: messageId === params.latestCommittedActivityKey,
            message: params.getMessageById(messageId),
            sessionActive: params.sessionActive,
        }));
        const hasToolProgress = messageStates.includes('tool-progress');
        const hasThinking = messageStates.includes('thinking');
        const hasStreaming = messageStates.includes('streaming');
        return {
            ...base,
            structuralKey: buildTurnShellStructuralKey({
                expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
                getMessageById: params.getMessageById,
                turn: item.turn,
            }),
            expansionKey: [
                buildToolExpansionKey(
                    item.turn.content.flatMap((content) => content.kind === 'tool_calls' ? content.toolMessageIds : []),
                    params.expandedToolCallsAnchorMessageIds,
                ),
                buildThinkingExpansionKey({
                    getMessageById: params.getMessageById,
                    messageIds,
                    resolveThinkingExpanded: params.resolveThinkingExpanded,
                }),
            ].join('|'),
            rowState: hasToolProgress
                ? 'tool-progress'
                : hasThinking
                    ? 'thinking'
                    : hasStreaming
                        ? 'streaming'
                        : 'stable',
        };
    }

    return {
        ...base,
        structuralKey: buildStableJsonSignature(item),
        expansionKey: 'tools:none|thinking:none',
        rowState: item.kind === 'pending-queue' || item.kind === 'action-draft' ? 'pending-action' : 'stable',
    };
}

function resolveForkContextKeyForItem(
    item: TranscriptRowShellItem,
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null,
): string {
    if (item.kind === 'fork-divider') {
        return `fork-divider:${item.parentSessionId}:${item.childSessionId}:${item.parentCutoffSeqInclusive}`;
    }
    if ('originSessionId' in item && item.originSessionId) {
        return `fork:${item.originSessionId}:${item.isReadOnlyContext === true ? 'readonly' : 'active'}`;
    }
    if (item.kind === 'turn') {
        const messageIds = collectMessageIdsFromTurn(item.turn);
        for (const messageId of messageIds) {
            const metadata = forkMessageMetadataById?.[messageId];
            if (metadata) {
                return `fork:${metadata.originSessionId}:${metadata.isReadOnlyContext ? 'readonly' : 'active'}`;
            }
        }
    }
    return 'fork:root';
}

function collectMessageIdsFromTurn(turn: TranscriptTurn): string[] {
    const ids: string[] = [];
    if (turn.userMessageId) ids.push(turn.userMessageId);
    for (const content of turn.content) {
        if (content.kind === 'message') {
            ids.push(content.messageId);
            continue;
        }
        for (const toolMessageId of content.toolMessageIds) {
            ids.push(toolMessageId);
        }
    }
    return ids;
}

function resolveMessageTextLength(message: Message | null): number {
    if (!message) return 0;
    const text = 'text' in message ? message.text : null;
    return typeof text === 'string' ? text.length : 0;
}

function resolveMessageRowType(message: Message | null, activeThinkingMessageId: string | null): string {
    if (!message) return 'message:agent-short';
    if (message.kind === 'tool-call') return 'message:tool';
    if (message.kind === 'agent-text') {
        if (message.isThinking === true || message.id === activeThinkingMessageId) return 'message:thinking';
        return resolveMessageTextLength(message) >= TRANSCRIPT_ROW_TYPE_LONG_TEXT_MIN_CHARS
            ? 'message:agent-long'
            : 'message:agent-short';
    }
    if (message.kind === 'user-text') {
        return resolveMessageTextLength(message) >= TRANSCRIPT_ROW_TYPE_LONG_TEXT_MIN_CHARS
            ? 'message:user-long'
            : 'message:user-short';
    }
    return 'message:agent-short';
}

function buildMessageShellStructuralKey(messageId: string, message: Message | null): string {
    if (!message) return `${messageId}:missing`;
    return buildStableJsonSignature(message);
}

function buildTurnShellStructuralKey(params: Readonly<{
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    getMessageById: (messageId: string) => Message | null;
    turn: TranscriptTurn;
}>): string {
    const messageRevisions: string[] = [];
    if (params.turn.userMessageId) {
        messageRevisions.push(buildMessageShellStructuralKey(params.turn.userMessageId, params.getMessageById(params.turn.userMessageId)));
    }
    return buildStableJsonSignature({
        id: params.turn.id,
        userMessageId: params.turn.userMessageId,
        content: params.turn.content.map((content) => {
            if (content.kind === 'message') {
                messageRevisions.push(buildMessageShellStructuralKey(content.messageId, params.getMessageById(content.messageId)));
                return content;
            }
            return {
                kind: 'tool_calls',
                id: content.id,
                signature: buildToolGroupShellSignatureValue({
                    getMessageById: params.getMessageById,
                    expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
                    toolMessageIds: content.toolMessageIds,
                }),
            };
        }),
        messageRevisions,
    });
}

function readToolStatusSignature(message: Message | null): string {
    if (message?.kind !== 'tool-call') return 'missing';
    const indicator = resolveToolStatusIndicatorKind(message.tool);
    if (indicator === 'running' || indicator === 'permission_pending') return 'running';
    if (indicator === 'error') return 'error';
    return 'completed';
}

function buildToolStatusSummary(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    toolMessageIds: readonly string[];
}>): string {
    let sawError = false;
    for (const messageId of params.toolMessageIds) {
        const status = readToolStatusSignature(params.getMessageById(messageId));
        if (status === 'running') return 'running';
        if (status === 'error') sawError = true;
    }
    return sawError ? 'error' : 'completed';
}

function selectCollapsedToolGroupSignatureMessageIds(toolMessageIds: readonly string[]): readonly string[] {
    return toolMessageIds.slice(-TRANSCRIPT_COLLAPSED_TOOL_GROUP_SIGNATURE_PREVIEW_COUNT);
}

function buildToolGroupShellSignatureValue(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    toolMessageIds: readonly string[];
}>) {
    const expanded = params.toolMessageIds.some((id) => params.expandedToolCallsAnchorMessageIds.has(id));
    const signatureMessageIds = expanded
        ? params.toolMessageIds
        : selectCollapsedToolGroupSignatureMessageIds(params.toolMessageIds);
    return {
        count: params.toolMessageIds.length,
        expanded,
        firstMessageId: params.toolMessageIds[0] ?? null,
        lastMessageId: params.toolMessageIds[params.toolMessageIds.length - 1] ?? null,
        status: buildToolStatusSummary({
            getMessageById: params.getMessageById,
            toolMessageIds: params.toolMessageIds,
        }),
        signatureMessageIds,
        messageRevisions: signatureMessageIds.map((messageId) => (
            buildMessageShellStructuralKey(messageId, params.getMessageById(messageId))
        )),
    };
}

function buildToolGroupShellStructuralKey(params: Readonly<{
    id: string;
    getMessageById: (messageId: string) => Message | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    toolMessageIds: readonly string[];
}>): string {
    return buildStableJsonSignature({
        id: params.id,
        ...buildToolGroupShellSignatureValue(params),
    });
}

function resolveMessageRowState(params: Readonly<{
    activeThinkingMessageId: string | null;
    isLatestCommittedActivity: boolean;
    message: Message | null;
    sessionActive: boolean;
}>): TranscriptItemHeightRowState {
    const { message } = params;
    if (!message) return 'stable';
    if (message.kind === 'agent-text' && (message.isThinking === true || message.id === params.activeThinkingMessageId)) {
        return 'thinking';
    }
    if (message.kind === 'tool-call') {
        const toolStatusKind = resolveToolStatusIndicatorKind(message.tool);
        if (toolStatusKind === 'running' || toolStatusKind === 'permission_pending') {
            return 'tool-progress';
        }
    }
    if (params.sessionActive && params.isLatestCommittedActivity) {
        return message.kind === 'tool-call' ? 'tool-progress' : 'streaming';
    }
    return 'stable';
}

function buildToolExpansionKey(
    toolMessageIds: readonly string[],
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>,
): string {
    if (toolMessageIds.length === 0) return 'tools:none';
    return toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))
        ? `tools:expanded:${toolMessageIds.join(',')}`
        : `tools:collapsed:${toolMessageIds.length}:${toolMessageIds[0] ?? ''}:${toolMessageIds[toolMessageIds.length - 1] ?? ''}`;
}

function buildThinkingExpansionKey(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    messageIds: readonly string[];
    resolveThinkingExpanded: (messageId: string) => boolean;
}>): string {
    const thinkingIds = params.messageIds.filter((messageId) => {
        const message = params.getMessageById(messageId);
        return message?.kind === 'agent-text' && message.isThinking === true;
    });
    if (thinkingIds.length === 0) return 'thinking:none';
    return `thinking:${thinkingIds.map((messageId) => `${messageId}:${params.resolveThinkingExpanded(messageId) ? 'expanded' : 'collapsed'}`).join(',')}`;
}

function buildStableJsonSignature(value: unknown): string {
    try {
        return JSON.stringify(value ?? null) ?? 'null';
    } catch {
        return String(value);
    }
}
