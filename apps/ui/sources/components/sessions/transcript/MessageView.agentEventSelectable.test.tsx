import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: vi.fn() },
        });
        return routerMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
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

describe('MessageView (agent events)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders agent-event text as selectable', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'agent-event',
            event: { type: 'message', message: 'hello event' },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
        const texts = screen.findAllByType('Text' as any);

        expect(texts.length).toBeGreaterThan(0);
        expect(texts.some((n: any) => n.props.selectable === true)).toBe(true);
    });

    it('renders agent events as inline left-aligned transcript rows with an icon', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'agent-event',
            event: { type: 'message', message: 'hello event' },
        };

        const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
        const icons = screen.findAllByType('Ionicons' as any);

        expect(icons.length).toBeGreaterThan(0);

        const row = icons[0]?.parent?.parent as any;

        expect(row).toBeTruthy();
        expect(row.props.style.flexDirection).toBe('row');
        expect(row.props.style.justifyContent).not.toBe('center');
    });
});
