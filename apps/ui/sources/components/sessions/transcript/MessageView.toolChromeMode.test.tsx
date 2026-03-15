import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => ({
    Platform: {
        OS: 'web',
        select: (values: any) => values?.web ?? values?.default,
    },
    Dimensions: {
        get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
    },
    useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
    View: 'View',
    Text: 'Text',
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                success: '#0a0',
                text: '#111',
                textSecondary: '#555',
                link: '#06f',
                surfaceHighest: '#fff',
                divider: '#ddd',
                input: { background: '#f7f7f7' },
                userMessageBackground: '#eef',
                agentEventText: '#777',
                warning: '#f90',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    success: '#0a0',
                    text: '#111',
                    textSecondary: '#555',
                    link: '#06f',
                    surfaceHighest: '#fff',
                    divider: '#ddd',
                    input: { background: '#f7f7f7' },
                    userMessageBackground: '#eef',
                    agentEventText: '#777',
                    warning: '#f90',
                },
            };
            return typeof input === 'function' ? input(theme, {}) : input;
        },
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

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
    shouldShowMessageCopyButton: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        submitMessage: vi.fn(),
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

const routerPushSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
    LinkedWorkspaceFilesRow: () => null,
}));

let toolChromeMode: 'cards' | 'activity_feed' = 'cards';
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'sessionThinkingDisplayMode') return 'inline';
        if (key === 'toolViewTimelineChromeMode') return toolChromeMode;
        return null;
    },
}));

afterEach(() => {
    toolChromeMode = 'cards';
});

describe('MessageView (tool timeline chrome mode)', () => {
    it('renders ToolTimelineRow when toolViewTimelineChromeMode is activity_feed', async () => {
        toolChromeMode = 'activity_feed';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(tree!.root.findAllByType('ToolTimelineRow' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('ToolView' as any)).toHaveLength(0);
    });

    it('renders ToolView when toolViewTimelineChromeMode is cards', async () => {
        toolChromeMode = 'cards';
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'tool-call',
            id: 'm1',
            localId: null,
            createdAt: 1,
            tool: {
                name: 'read',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: {},
            },
            children: [],
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
        });

        expect(tree!.root.findAllByType('ToolView' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('ToolTimelineRow' as any)).toHaveLength(0);
    });
});
