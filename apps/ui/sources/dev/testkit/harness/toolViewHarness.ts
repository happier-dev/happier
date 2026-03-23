import * as React from 'react';
import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { flushHookEffects, type FlushHookEffectsOptions } from '../hooks/flushHookEffects';
import { renderScreen, type RenderScreenResult } from '../render/renderScreen';

type ToolInteractionState = Readonly<{
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
}>;

export type ToolViewHarnessOptions = Readonly<{
    tool: ToolCall;
    metadata?: Metadata | null;
    messages?: Message[];
    onPress?: () => void;
    sessionId?: string;
    messageId?: string;
    forcePermissionPromptsInTranscript?: boolean;
    interaction?: ToolInteractionState;
}>;

export type ToolViewHarness = RenderScreenResult & Readonly<{
    findSubtitle: () => ReturnType<RenderScreenResult['findByTestId']>;
    findPermissionFooter: () => ReturnType<RenderScreenResult['findByTestId']>;
    findSpecificToolView: () => ReturnType<RenderScreenResult['findByTestId']>;
    settle: (options?: FlushHookEffectsOptions) => Promise<void>;
}>;

export async function renderToolView(options: ToolViewHarnessOptions): Promise<ToolViewHarness> {
    const { ToolView } = await import('@/components/tools/shell/views/ToolView');
    const screen = await renderScreen(
        React.createElement(ToolView, {
            tool: options.tool,
            metadata: options.metadata ?? null,
            messages: options.messages ?? [],
            onPress: options.onPress,
            sessionId: options.sessionId,
            messageId: options.messageId,
            forcePermissionPromptsInTranscript: options.forcePermissionPromptsInTranscript,
            interaction: options.interaction,
        }),
    );

    return {
        ...screen,
        findSubtitle: () => screen.findByTestId('tool-card-subtitle'),
        findPermissionFooter: () => screen.findByTestId('tool-permission-footer'),
        findSpecificToolView: () => screen.findByTestId('specific-tool-view'),
        settle: async (flushOptions) => {
            await flushHookEffects(flushOptions);
        },
    };
}
