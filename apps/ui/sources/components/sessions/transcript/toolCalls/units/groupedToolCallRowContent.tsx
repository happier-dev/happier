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
import type {
    TranscriptForkCommon,
    TranscriptMessageDisplayCommon,
    TranscriptToolChromeCommon,
    TranscriptToolRouteCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

import {
    type GroupedToolCallChromeMode,
    shouldRenderGroupedToolCallWithMessageView,
} from './groupedToolCallRowRenderDecision';

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
