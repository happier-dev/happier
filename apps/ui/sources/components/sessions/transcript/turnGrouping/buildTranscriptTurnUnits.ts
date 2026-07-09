import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { Message } from '@/sync/domains/messages/messageTypes';

import type { TranscriptTurn } from './buildTranscriptTurns';

type ForkMessageMetadata = Readonly<{
    originSessionId: string;
    isReadOnlyContext: boolean;
}>;

/**
 * Stable per-unit virtualization rows for one semantic tool-call group (plan N2c).
 *
 * One semantic group decomposes into one `header..footer` span: dedicated cap rows own the
 * position-dependent chrome so every tool row stays uniform — streaming appends and prepend
 * merges become BETWEEN-row insertions that list-level position maintenance can handle.
 * All unit ids derive purely from `groupId` + `toolMessageId`, so upstream sticky group-id
 * remapping (`buildTranscriptTurnsCached`) keeps them stable across prepend merges.
 */
export type TranscriptToolGroupUnitItem =
    | {
        kind: 'tool-group-header';
        id: string; // `${groupId}#header`
        groupId: string;
        toolMessageIds: string[]; // ALL tools in the semantic group
        expanded: boolean;
        hiddenCount: number; // 0 when expanded
        createdAt: number; // first tool message createdAt (0 fallback)
        originSessionId?: string;
        isReadOnlyContext?: boolean;
    }
    | {
        kind: 'tool-group-expand';
        id: string; // `${groupId}#expand`
        groupId: string;
        toolMessageIds: string[];
        hiddenCount: number; // > 0 by construction (only emitted while collapsed && hiddenCount > 0)
        createdAt: number;
        originSessionId?: string;
        isReadOnlyContext?: boolean;
    }
    | {
        kind: 'tool-group-tool';
        id: string; // `${groupId}#tool:${toolMessageId}` — SAME id whether the row is a collapsed preview-tail row or an expanded body row
        groupId: string;
        toolMessageId: string;
        toolMessageIds: string[]; // full group membership (for expansion-state checks)
        expanded: boolean; // group expansion at build time
        createdAt: number; // own message createdAt (0 fallback)
        seq: number | null; // own message seq (normalized like splitter)
        originSessionId?: string;
        isReadOnlyContext?: boolean;
    }
    | {
        kind: 'tool-group-footer';
        id: string; // `${groupId}#footer`
        groupId: string;
        toolMessageIds: string[];
        expanded: boolean;
        createdAt: number;
        originSessionId?: string;
        isReadOnlyContext?: boolean;
    };

export type TranscriptTurnUnitSourceItem =
    | ChatListItem
    | { kind: 'turn'; id: string; turn: TranscriptTurn }
    // Already-decomposed unit items pass through unchanged, so callers holding the
    // wider transcript row union (e.g. ChatList) can feed the builder without narrowing.
    | TranscriptToolGroupUnitItem;
export type TranscriptTurnUnitListItem = Exclude<ChatListItem, { kind: 'tool-calls-group' }> | TranscriptToolGroupUnitItem;

function readMessageMetadata(
    metadataByMessageId: Readonly<Record<string, ForkMessageMetadata>> | undefined,
    messageId: string,
): ForkMessageMetadata | null {
    return metadataByMessageId?.[messageId] ?? null;
}

function normalizeCreatedAt(message: Message | null | undefined): number {
    return typeof message?.createdAt === 'number' && Number.isFinite(message.createdAt) ? message.createdAt : 0;
}

function normalizeSeq(message: Message | null | undefined): number | null {
    return typeof message?.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : null;
}

function normalizeCollapsedPreviewCount(value: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function metadataFields(metadata: ForkMessageMetadata | null): Partial<Pick<TranscriptToolGroupUnitItem, 'originSessionId' | 'isReadOnlyContext'>> {
    if (!metadata) return {};
    return {
        originSessionId: metadata.originSessionId,
        isReadOnlyContext: metadata.isReadOnlyContext,
    };
}

function buildMessageItem(params: Readonly<{
    messageId: string;
    getMessageById: (messageId: string) => Message | null;
    metadataByMessageId?: Readonly<Record<string, ForkMessageMetadata>>;
}>): Extract<ChatListItem, { kind: 'message' }> {
    const message = params.getMessageById(params.messageId);
    const metadata = readMessageMetadata(params.metadataByMessageId, params.messageId);
    return {
        kind: 'message',
        id: `msg:${params.messageId}`,
        messageId: params.messageId,
        ...metadataFields(metadata),
        createdAt: normalizeCreatedAt(message),
        seq: normalizeSeq(message),
    };
}

function appendToolGroupUnits(params: Readonly<{
    output: TranscriptTurnUnitListItem[];
    groupId: string;
    toolMessageIds: readonly string[];
    getMessageById: (messageId: string) => Message | null;
    metadataByMessageId?: Readonly<Record<string, ForkMessageMetadata>>;
    /** Linear group items carry their own fork metadata; turn-derived groups pass null. */
    groupItemMetadata: ForkMessageMetadata | null;
    isGroupExpanded: (toolMessageIds: readonly string[]) => boolean;
    collapsedPreviewCount: number;
}>): void {
    if (params.toolMessageIds.length === 0) return;

    const toolMessageIds = [...params.toolMessageIds];
    const firstToolMessageId = toolMessageIds[0]!;
    const expanded = params.isGroupExpanded(toolMessageIds);
    const createdAt = normalizeCreatedAt(params.getMessageById(firstToolMessageId));
    const capMetadata = params.groupItemMetadata
        ?? readMessageMetadata(params.metadataByMessageId, firstToolMessageId);
    const capMetadataFields = metadataFields(capMetadata);

    const visibleToolMessageIds = expanded
        ? toolMessageIds
        : params.collapsedPreviewCount > 0
            ? toolMessageIds.slice(Math.max(0, toolMessageIds.length - params.collapsedPreviewCount))
            : [];
    const hiddenCount = expanded ? 0 : toolMessageIds.length - visibleToolMessageIds.length;

    params.output.push({
        kind: 'tool-group-header',
        id: `${params.groupId}#header`,
        groupId: params.groupId,
        toolMessageIds,
        expanded,
        hiddenCount,
        createdAt,
        ...capMetadataFields,
    });

    if (!expanded && hiddenCount > 0) {
        params.output.push({
            kind: 'tool-group-expand',
            id: `${params.groupId}#expand`,
            groupId: params.groupId,
            toolMessageIds,
            hiddenCount,
            createdAt,
            ...capMetadataFields,
        });
    }

    for (const toolMessageId of visibleToolMessageIds) {
        const message = params.getMessageById(toolMessageId);
        const toolMetadata = readMessageMetadata(params.metadataByMessageId, toolMessageId)
            ?? params.groupItemMetadata;
        params.output.push({
            kind: 'tool-group-tool',
            id: `${params.groupId}#tool:${toolMessageId}`,
            groupId: params.groupId,
            toolMessageId,
            toolMessageIds,
            expanded,
            createdAt: normalizeCreatedAt(message),
            seq: normalizeSeq(message),
            ...metadataFields(toolMetadata),
        });
    }

    params.output.push({
        kind: 'tool-group-footer',
        id: `${params.groupId}#footer`,
        groupId: params.groupId,
        toolMessageIds,
        expanded,
        createdAt,
        ...capMetadataFields,
    });
}

export function buildTranscriptTurnUnits(params: Readonly<{
    items: readonly TranscriptTurnUnitSourceItem[];
    getMessageById: (messageId: string) => Message | null;
    metadataByMessageId?: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>>;
    isGroupExpanded: (toolMessageIds: readonly string[]) => boolean;
    collapsedPreviewCount: number; // already-resolved K; <= 0 means no preview tail
}>): TranscriptTurnUnitListItem[] {
    const collapsedPreviewCount = normalizeCollapsedPreviewCount(params.collapsedPreviewCount);
    const output: TranscriptTurnUnitListItem[] = [];

    for (const item of params.items) {
        if (item.kind === 'turn') {
            if (item.turn.userMessageId) {
                output.push(buildMessageItem({
                    messageId: item.turn.userMessageId,
                    getMessageById: params.getMessageById,
                    metadataByMessageId: params.metadataByMessageId,
                }));
            }
            for (const content of item.turn.content) {
                if (content.kind === 'message') {
                    output.push(buildMessageItem({
                        messageId: content.messageId,
                        getMessageById: params.getMessageById,
                        metadataByMessageId: params.metadataByMessageId,
                    }));
                    continue;
                }
                appendToolGroupUnits({
                    output,
                    groupId: content.id,
                    toolMessageIds: content.toolMessageIds,
                    getMessageById: params.getMessageById,
                    metadataByMessageId: params.metadataByMessageId,
                    groupItemMetadata: null,
                    isGroupExpanded: params.isGroupExpanded,
                    collapsedPreviewCount,
                });
            }
            continue;
        }

        if (item.kind === 'tool-calls-group') {
            const groupItemMetadata: ForkMessageMetadata | null =
                item.originSessionId != null && item.isReadOnlyContext != null
                    ? { originSessionId: item.originSessionId, isReadOnlyContext: item.isReadOnlyContext }
                    : null;
            appendToolGroupUnits({
                output,
                groupId: item.id,
                toolMessageIds: item.toolMessageIds,
                getMessageById: params.getMessageById,
                metadataByMessageId: params.metadataByMessageId,
                groupItemMetadata,
                isGroupExpanded: params.isGroupExpanded,
                collapsedPreviewCount,
            });
            continue;
        }

        output.push(item);
    }

    return output;
}
