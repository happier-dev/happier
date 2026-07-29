import * as React from 'react';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import type { ToolRowPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import type {
    TranscriptForkCommon,
    TranscriptMessageDisplayCommon,
    TranscriptToolChromeCommon,
    TranscriptToolRouteCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

export type GroupedToolCallChromeMode = 'activity_feed' | 'cards';

export function shouldRenderGroupedToolCallWithMessageView(
    message: ToolCallMessage,
    chromeMode: GroupedToolCallChromeMode,
    groupExpanded: boolean,
): boolean {
    if (chromeMode === 'cards') {
        return true;
    }
    const hasStructuredMeta = Boolean(message.meta?.happier);
    if (hasStructuredMeta) return true;

    // Avoid switching the renderer for subagent tool calls based on streaming children.
    // Otherwise the row remounts (ToolTimelineRow → MessageView) and the user's expanded/collapsed state resets.
    if (isSubAgentTranscriptToolName(message.tool?.name ?? '')) {
        return groupExpanded;
    }

    return false;
}

export function resolveGroupedPreviewSidechainIds(params: Readonly<{
    chromeMode: GroupedToolCallChromeMode;
    previewMessages: readonly ToolCallMessage[];
}>): readonly string[] {
    if (params.chromeMode !== 'activity_feed') {
        return [];
    }

    const sidechainIds = new Set<string>();
    for (const message of params.previewMessages) {
        const toolName = typeof message.tool?.name === 'string' ? message.tool.name : '';
        if (!isSubAgentTranscriptToolName(toolName)) continue;
        const sidechainId = resolveToolTranscriptSidechainId({
            tool: message.tool,
            normalizedToolName: toolName,
        });
        if (!sidechainId) continue;
        sidechainIds.add(sidechainId);
    }
    return [...sidechainIds];
}

export function renderGroupedToolCallRowContent(params: Readonly<{
    message: ToolCallMessage;
    chromeMode: GroupedToolCallChromeMode;
    groupExpanded: boolean;
    metadata: Metadata | null;
    sessionId: string;
    nestedMessageId: string | undefined;
    forcePermissionPromptsInTranscript?: boolean;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    messagePins?: readonly PersistedSessionMessagePinV1[];
    onToggleToolPin?: (pin: PersistedSessionMessagePinV1) => void;
    toolPinAction?: ToolRowPinAction | null;
    interaction: TranscriptInteraction;
    forkCommon: TranscriptForkCommon;
    messageDisplayCommon: TranscriptMessageDisplayCommon;
    toolChromeCommon: TranscriptToolChromeCommon;
    toolRouteCommon: TranscriptToolRouteCommon;
}>): React.ReactNode {
    if (shouldRenderGroupedToolCallWithMessageView(params.message, params.chromeMode, params.groupExpanded)) {
        return (
            <MessageViewWithSessionCommon
                message={params.message}
                metadata={params.metadata}
                sessionId={params.sessionId}
                layoutContext="tool_calls_group"
                forcePermissionPromptsInTranscript={params.forcePermissionPromptsInTranscript}
                approvalRequests={params.approvalRequests}
                messagePins={params.messagePins}
                onToggleToolPin={params.onToggleToolPin}
                interaction={params.interaction}
                forkCommon={params.forkCommon}
                messageDisplayCommon={params.messageDisplayCommon}
                toolChromeCommon={params.toolChromeCommon}
                toolRouteCommon={params.toolRouteCommon}
            />
        );
    }

    if (params.chromeMode === 'activity_feed') {
        return (
            <ToolTimelineRow
                tool={params.message.tool}
                metadata={params.metadata}
                messages={params.message.children}
                sessionId={params.sessionId}
                messageId={params.nestedMessageId}
                jumpHighlightSeq={params.message.seq ?? null}
                headerAction={params.toolPinAction}
                forcePermissionPromptsInTranscript={params.forcePermissionPromptsInTranscript}
                approvalRequests={params.approvalRequests}
                interaction={params.interaction}
            />
        );
    }

    return (
        <ToolView
            tool={params.message.tool}
            metadata={params.metadata}
            messages={params.message.children}
            sessionId={params.sessionId}
            messageId={params.nestedMessageId}
            jumpHighlightSeq={params.message.seq ?? null}
            headerAction={params.toolPinAction}
            forcePermissionPromptsInTranscript={params.forcePermissionPromptsInTranscript}
            approvalRequests={params.approvalRequests}
            interaction={params.interaction}
            embedded
        />
    );
}
