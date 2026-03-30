import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createToolCallMessageFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReducer } from '@/sync/reducer/reducer';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        });
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key: string) => key,
    }),
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSetting: (key: string) => {
                if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                return null;
            },
            useSession: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => createReducer(),
        });
    },
});

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: (props: any) => React.createElement('StructuredMessageBlock', props),
    renderStructuredMessage: (params: any) => {
        return params?.message?.meta?.happier ? React.createElement('StructuredNode') : null;
    },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
    LinkedWorkspaceFilesRow: () => null,
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: vi.fn(), sendMessage: vi.fn() },
}));

describe('MessageView (tool-call chrome in activity feed)', () => {
    afterEach(standardCleanup);

    it('renders a ToolTimelineRow for errored tool calls even when a structured node exists', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = createToolCallMessageFixture({
            id: 'tool-1',
            createdAt: 1,
            tool: {
                id: 'call-1',
                name: 'Search',
                state: 'error',
                input: { query: 'foo' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: { error: { message: 'Ripgrep search timed out after 20 seconds.' } },
            },
            children: [],
            meta: { happier: { kind: 'search_content.v1', payload: {} } } as any,
        });

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={{} as any}
                sessionId="s1"
                layoutContext="tool_calls_group"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        const rows = screen.findAll((n: any) => n.type === 'ToolTimelineRow');
        expect(rows.length).toBe(1);
    });

    it('renders a ToolTimelineRow when an inactive session forces a pending permission tool into error while a structured node exists', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = createToolCallMessageFixture({
            id: 'tool-inactive-1',
            createdAt: 1,
            tool: {
                id: 'call-inactive-1',
                name: 'WebSearch',
                state: 'running',
                input: { query: 'foo' },
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: null,
                permission: { id: 'perm-1', kind: 'tools', status: 'pending' },
            },
            children: [],
            meta: { happier: { kind: 'tool_permission_prompt.v1', payload: {} } } as any,
        });

        const screen = await renderScreen(
            <MessageView
                message={message}
                metadata={{} as any}
                sessionId="s1"
                layoutContext="tool_calls_group"
                interaction={{ canSendMessages: true, canApprovePermissions: true, permissionDisabledReason: 'inactive' }}
            />,
        );

        const rows = screen.findAll((n: any) => n.type === 'ToolTimelineRow');
        expect(rows.length).toBe(1);
    });
});
