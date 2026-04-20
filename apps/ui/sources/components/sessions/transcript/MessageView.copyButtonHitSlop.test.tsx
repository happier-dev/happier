import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android',
}));

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: Record<string, unknown>) =>
                    values?.[platformState.os] ?? values?.default,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: () => null,
                useSession: () => null,
            },
        });
    },
});

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

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
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

describe('MessageView (copy button hitSlop)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it.each(['ios', 'android'] as const)(
        'renders inline message actions on %s instead of relying on long-press dropdowns',
        async (platformOS) => {
            platformState.os = platformOS;
            vi.resetModules();
            const { MessageView } = await import('./MessageView');

            const message: any = {
                kind: 'user-text',
                localId: 'local-1',
                id: 'm1',
                text: 'hello',
            };

            const screen = await renderScreen(
                <MessageView message={message} metadata={null} sessionId="s1" />,
            );

            const copyButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-copy:m1',
            );
            expect(copyButtons).toHaveLength(1);

            const longPressables = screen.findAll(
                (node: any) => node.type === 'Pressable' && typeof node.props?.onLongPress === 'function',
            );
            expect(longPressables).toHaveLength(0);

            const dropdowns = screen.findAllByType('DropdownMenu');
            expect(dropdowns).toHaveLength(0);
        },
    );
});
