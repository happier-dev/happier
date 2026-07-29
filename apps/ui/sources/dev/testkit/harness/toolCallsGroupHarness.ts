import * as React from 'react';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ToolCallsGroupStatus } from '@/components/sessions/transcript/toolCalls/units/toolCallsGroupChrome';

import { renderScreen, type RenderScreenResult } from '../render/renderScreen';

const defaultTranscriptInteraction: TranscriptInteraction = {
    canSendMessages: true,
    canApprovePermissions: true,
};

export type ToolCallsGroupHarnessOptions = Readonly<{
    id?: string;
    status?: ToolCallsGroupStatus;
    toolMessages: ToolCallMessage[];
    metadata?: Metadata | null;
    sessionId?: string;
    forcePermissionPromptsInTranscript?: boolean;
    expanded?: boolean;
    setExpanded?: (expanded: boolean) => void;
    messagePins?: readonly PersistedSessionMessagePinV1[];
    onToggleToolPin?: (pin: PersistedSessionMessagePinV1) => void;
    interaction?: TranscriptInteraction;
}>;

export async function renderToolCallsGroupView(
    options: ToolCallsGroupHarnessOptions,
): Promise<RenderScreenResult> {
    const { ToolCallsGroupView } = await import('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView');

    return renderScreen(
        React.createElement(ToolCallsGroupView, {
            id: options.id ?? 'toolCalls:1',
            status: options.status ?? 'running',
            toolMessages: options.toolMessages,
            metadata: options.metadata ?? null,
            sessionId: options.sessionId ?? 's1',
            forcePermissionPromptsInTranscript: options.forcePermissionPromptsInTranscript,
            expanded: options.expanded ?? false,
            setExpanded: options.setExpanded ?? (() => {}),
            messagePins: options.messagePins,
            onToggleToolPin: options.onToggleToolPin,
            interaction: options.interaction ?? defaultTranscriptInteraction,
        }),
    );
}

export async function renderStatefulToolCallsGroupView(
    options: ToolCallsGroupHarnessOptions,
): Promise<RenderScreenResult> {
    const { ToolCallsGroupView } = await import('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView');

    function Harness(): React.ReactElement {
        const [expanded, setExpanded] = React.useState(options.expanded ?? false);

        return React.createElement(ToolCallsGroupView, {
            id: options.id ?? 'toolCalls:1',
            status: options.status ?? 'running',
            toolMessages: options.toolMessages,
            metadata: options.metadata ?? null,
            sessionId: options.sessionId ?? 's1',
            forcePermissionPromptsInTranscript: options.forcePermissionPromptsInTranscript,
            expanded,
            setExpanded,
            messagePins: options.messagePins,
            onToggleToolPin: options.onToggleToolPin,
            interaction: options.interaction ?? defaultTranscriptInteraction,
        });
    }

    return renderScreen(React.createElement(Harness));
}
