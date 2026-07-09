import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import type { TranscriptToolGroupUnitItem } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import type { Message } from '@/sync/domains/messages/messageTypes';

import type {
    TranscriptItemHeightRowState,
    TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';

const TRANSCRIPT_COLLAPSED_TOOL_GROUP_SIGNATURE_PREVIEW_COUNT = 15;

export type TranscriptRowShellItem =
    | ChatListItem
    | {
        kind: 'turn';
        id: string;
        turn: TranscriptTurn;
    }
    | TranscriptToolGroupUnitItem;

function isToolGroupUnitItem(item: TranscriptRowShellItem): item is TranscriptToolGroupUnitItem {
    return (
        item.kind === 'tool-group-header' ||
        item.kind === 'tool-group-expand' ||
        item.kind === 'tool-group-tool' ||
        item.kind === 'tool-group-footer'
    );
}

export function resolveTranscriptItemActiveThinkingMessageId(
    item: TranscriptRowShellItem,
    activeThinkingMessageId: string | null,
): string | null {
    if (!activeThinkingMessageId) return null;
    if (item.kind === 'message') {
        return item.messageId === activeThinkingMessageId ? activeThinkingMessageId : null;
    }
    if (item.kind === 'turn') {
        return turnContainsMessageId(item.turn, activeThinkingMessageId) ? activeThinkingMessageId : null;
    }
    return null;
}

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
    if (isToolGroupUnitItem(item)) return item.kind;
    if (item.kind === 'pending-queue') return 'pending-action';
    if (item.kind === 'pending-user-action') return 'pending-action';
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
    return 'message:agent';
}

export function buildTranscriptRowShellSignature(params: Readonly<{
    activeThinkingMessageId: string | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null;
    getMessageById: (messageId: string) => Message | null;
    /**
     * R1: message structural keys are revision-based, never content-based. The store bumps
     * `messageRevisionsById` exactly when a message is written, so `id + revision` invalidates
     * whenever content can have changed — without serializing the (potentially multi-MB) message.
     * Returning `null` (message without a tracked revision, e.g. fork-context messages) falls
     * back to the legacy content signature for that message only.
     */
    getMessageRevisionById: (messageId: string) => number | null;
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
            structuralKey: buildMessageShellStructuralKey(item.messageId, message, params.getMessageRevisionById(item.messageId)),
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
                getMessageRevisionById: params.getMessageRevisionById,
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

    // Per-unit tool-group rows (N2c): deliberately SMALL structural keys so the height
    // cache stays valid across sibling churn — caps key on group facts only, tool rows
    // key on their OWN message revision plus group expansion.
    if (item.kind === 'tool-group-header') {
        return {
            ...base,
            structuralKey: buildStableJsonSignature({
                groupId: item.groupId,
                count: item.toolMessageIds.length,
                status: buildToolStatusSummary({
                    getMessageById: params.getMessageById,
                    toolMessageIds: item.toolMessageIds,
                }),
                expanded: item.expanded,
            }),
            expansionKey: [item.expanded ? 'tools:expanded' : 'tools:collapsed', 'thinking:none'].join('|'),
            rowState: 'stable',
        };
    }

    if (item.kind === 'tool-group-expand') {
        return {
            ...base,
            structuralKey: buildStableJsonSignature({
                groupId: item.groupId,
                hiddenCount: item.hiddenCount,
            }),
            expansionKey: 'tools:collapsed|thinking:none',
            rowState: 'stable',
        };
    }

    if (item.kind === 'tool-group-tool') {
        const message = params.getMessageById(item.toolMessageId);
        return {
            ...base,
            structuralKey: buildStableJsonSignature({
                groupId: item.groupId,
                groupExpanded: item.expanded,
                messageRevision: buildMessageShellStructuralKey(item.toolMessageId, message, params.getMessageRevisionById(item.toolMessageId)),
            }),
            expansionKey: [item.expanded ? 'tools:expanded' : 'tools:collapsed', 'thinking:none'].join('|'),
            rowState: resolveMessageRowState({
                activeThinkingMessageId: params.activeThinkingMessageId,
                isLatestCommittedActivity: item.toolMessageId === params.latestCommittedActivityKey,
                message,
                sessionActive: params.sessionActive,
            }),
        };
    }

    if (item.kind === 'tool-group-footer') {
        return {
            ...base,
            structuralKey: buildStableJsonSignature({ groupId: item.groupId }),
            expansionKey: 'tools:none|thinking:none',
            rowState: 'stable',
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
                getMessageRevisionById: params.getMessageRevisionById,
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
        rowState: item.kind === 'pending-queue' || item.kind === 'pending-user-action' || item.kind === 'action-draft'
            ? 'pending-action'
            : 'stable',
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

function turnContainsMessageId(turn: TranscriptTurn, messageId: string): boolean {
    if (turn.userMessageId === messageId) return true;
    for (const content of turn.content) {
        if (content.kind === 'message') {
            if (content.messageId === messageId) return true;
            continue;
        }
        if (content.toolMessageIds.includes(messageId)) return true;
    }
    return false;
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

/**
 * C1 (T2): the FlashList recycle type must be SHAPE-only, never SIZE-based. A length-gated
 * short/long split flips the type mid-stream (at the old 512-char threshold), remounting the cell
 * into a different recycle pool and stranding it at an unmeasured estimate for >=1 frame — the prime
 * overlap trigger. Thinking is kept as a genuinely distinct rendered shell shape; only the size flip
 * was the bug. See `.reviews/2026-06-14-091335-transcript-deep-audit/subagents/19-design-C1-measurement.md`.
 */
function resolveMessageRowType(message: Message | null, activeThinkingMessageId: string | null): string {
    if (!message) return 'message:agent';
    if (message.kind === 'tool-call') return 'message:tool';
    if (message.kind === 'agent-text') {
        if (message.isThinking === true || message.id === activeThinkingMessageId) return 'message:thinking';
        return 'message:agent';
    }
    if (message.kind === 'user-text') {
        return 'message:user';
    }
    return 'message:agent';
}

function buildMessageShellStructuralKey(
    messageId: string,
    message: Message | null,
    revision: number | null,
): string {
    if (!message) return `${messageId}:missing`;
    // R1: revision-keyed — the store bumps the revision on every write of this message, so
    // `id + revision` changes exactly when the message content can have changed. Never
    // serialize the message itself (tool results reach tens of MB).
    if (typeof revision === 'number' && Number.isFinite(revision)) {
        return `${messageId}:r${Math.trunc(revision)}`;
    }
    return buildStableJsonSignature(message);
}

function buildTurnShellStructuralKey(params: Readonly<{
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    getMessageById: (messageId: string) => Message | null;
    getMessageRevisionById: (messageId: string) => number | null;
    turn: TranscriptTurn;
}>): string {
    const messageRevisions: string[] = [];
    if (params.turn.userMessageId) {
        messageRevisions.push(buildMessageShellStructuralKey(
            params.turn.userMessageId,
            params.getMessageById(params.turn.userMessageId),
            params.getMessageRevisionById(params.turn.userMessageId),
        ));
    }
    return buildStableJsonSignature({
        id: params.turn.id,
        userMessageId: params.turn.userMessageId,
        content: params.turn.content.map((content) => {
            if (content.kind === 'message') {
                messageRevisions.push(buildMessageShellStructuralKey(
                    content.messageId,
                    params.getMessageById(content.messageId),
                    params.getMessageRevisionById(content.messageId),
                ));
                return content;
            }
            return {
                kind: 'tool_calls',
                id: content.id,
                signature: buildToolGroupShellSignatureValue({
                    getMessageById: params.getMessageById,
                    getMessageRevisionById: params.getMessageRevisionById,
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
    getMessageRevisionById: (messageId: string) => number | null;
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
            buildMessageShellStructuralKey(messageId, params.getMessageById(messageId), params.getMessageRevisionById(messageId))
        )),
    };
}

function buildToolGroupShellStructuralKey(params: Readonly<{
    id: string;
    getMessageById: (messageId: string) => Message | null;
    getMessageRevisionById: (messageId: string) => number | null;
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
