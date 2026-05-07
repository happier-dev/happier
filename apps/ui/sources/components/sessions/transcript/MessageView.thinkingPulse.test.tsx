import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    thinkingPulseProps: [] as any[],
    markdownProps: [] as any[],
    thinkingRowProps: [] as any[],
}));

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Easing: {
                bezier: () => ({}),
                linear: () => ({}),
            },
            Animated: {
                Value: class AnimatedValue {
                    constructor(public _value: number) {}
                    interpolate() {
                        return this as any;
                    }
                },
                timing: (_value: any, _config: any) => ({
                    start: (cb?: any) => {
                        cb?.();
                    },
                }),
                View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
            },
            Dimensions: {
                get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: vi.fn() },
        });
        return routerMock.module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'full';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    return null;
                },
                useSession: () => null,
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { submitMessage: vi.fn(), sendMessage: vi.fn() } }));
vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => {
        captured.markdownProps.push(props);
        return React.createElement('MarkdownView', props);
    },
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@/components/tools/shell/views/ToolView', () => ({ ToolView: () => React.createElement('ToolView') }));
vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({ ToolTimelineRow: () => React.createElement('ToolTimelineRow') }));
vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    renderStructuredMessage: () => null,
    StructuredMessageBlock: () => React.createElement('StructuredMessageBlock'),
}));
vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({ shouldShowMessageCopyButton: () => false }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({ isCommittedMessageDiscarded: () => false }));
vi.mock('@/utils/url/sessionFileDeepLink', () => ({ buildSessionFileDeepLink: () => '' }));
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (p: any) => p }));
vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({ extractWorkspaceFileMentions: () => [] }));
vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({ LinkedWorkspaceFilesRow: () => React.createElement('LinkedWorkspaceFilesRow') }));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionContext', () => ({
    useTranscriptMotion: () => ({
        gate: { isFresh: () => true },
        config: { preset: 'subtle', freshnessMs: 10_000, animateNewItemsEnabled: true, animateToolExpandCollapseEnabled: true, animateToolExpandCollapseFreshOnly: true, animateThinkingEnabled: true },
    }),
}));

vi.mock('@/components/sessions/transcript/motion/ThinkingPulseLabel', () => ({
    ThinkingPulseLabel: (props: any) => {
        captured.thinkingPulseProps.push(props);
        return React.createElement('ThinkingPulseLabel', props);
    },
}));

vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', async () => {
    const actual: any = await vi.importActual('@/components/sessions/transcript/thinking/ThinkingTimelineRow');
    return {
        ...actual,
        ThinkingTimelineRow: (props: any) => {
            captured.thinkingRowProps.push(props);
            return React.createElement(actual.ThinkingTimelineRow, props, props.children);
        },
    };
});

afterEach(() => {
    standardCleanup();
});

describe('MessageView (thinking pulse gating)', () => {
    it('enables the pulse only for the active thinking message id', async () => {
        const { MessageView } = await import('./MessageView');
        captured.thinkingPulseProps.length = 0;
        captured.markdownProps.length = 0;
        captured.thinkingRowProps.length = 0;

        const baseMessage: any = {
            kind: 'agent-text',
            id: 'm1',
            localId: 'm1',
            createdAt: 1,
            text: 'thinking text',
            isThinking: true,
        };

        const screen = await renderScreen(
            <MessageView
                message={baseMessage}
                metadata={null}
                sessionId="s1"
                activeThinkingMessageId="m1"
            />,
        );
        expect(captured.thinkingPulseProps.at(-1)?.enabled).toBe(true);
        expect(captured.thinkingRowProps.at(-1)?.chrome).toBe('plain');
        expect(captured.markdownProps.at(-1)?.testID).toBe('transcript-thinking-body-markdown');
        expect(captured.markdownProps.at(-1)?.profile).toBe('thinking');
        expect(screen.findAll((node) => (node.props as any).testID === 'transcript-thinking-body-plain')).toHaveLength(0);

        captured.thinkingPulseProps.length = 0;
        captured.markdownProps.length = 0;
        captured.thinkingRowProps.length = 0;
        const nextScreen = await renderScreen(
            <MessageView
                message={baseMessage}
                metadata={null}
                sessionId="s1"
                activeThinkingMessageId="m2"
            />,
        );
        expect(captured.thinkingPulseProps.at(-1)?.enabled).toBe(false);
        expect(captured.markdownProps.at(-1)?.textStyle?.fontStyle).toBe('italic');
        expect(nextScreen.findAll((node) => (node.props as any).testID === 'transcript-thinking-body-plain')).toHaveLength(0);
    });
});
