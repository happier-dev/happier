import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    thinkingPulseProps: [] as any[],
    markdownProps: [] as any[],
    thinkingRowProps: [] as any[],
}));

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (values: any) => values?.web ?? values?.default,
    },
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
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#777',
                text: '#111',
                divider: '#ddd',
                input: { background: '#f7f7f7' },
                userMessageBackground: '#eef',
                agentEventText: '#999',
                surfaceHighest: '#fff',
                success: '#0a0',
                link: '#06f',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input(
                    {
                        colors: {
                            textSecondary: '#777',
                            text: '#111',
                            divider: '#ddd',
                            input: { background: '#f7f7f7' },
                            userMessageBackground: '#eef',
                            agentEventText: '#999',
                            surfaceHighest: '#fff',
                            success: '#0a0',
                            link: '#06f',
                        },
                    },
                    {},
                )
                : input,
    },
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
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
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({ isCommittedMessageDiscarded: () => false }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'sessionThinkingDisplayMode') return 'inline';
        if (key === 'sessionThinkingInlinePresentation') return 'full';
        if (key === 'sessionThinkingInlineChrome') return 'plain';
        return null;
    },
    useSession: () => null,
}));

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <MessageView
                    message={baseMessage}
                    metadata={null}
                    sessionId="s1"
                    activeThinkingMessageId="m1"
                />,
            );
        });
        expect(captured.thinkingPulseProps.at(-1)?.enabled).toBe(true);
        expect(captured.thinkingRowProps.at(-1)?.chrome).toBe('plain');
        expect(captured.markdownProps.at(-1)?.testID).toBe('transcript-thinking-body-markdown');
        expect(captured.markdownProps.at(-1)?.variant).toBe('thinking');
        expect(tree!.root.findAll((node) => (node.props as any).testID === 'transcript-thinking-body-plain')).toHaveLength(0);

        captured.thinkingPulseProps.length = 0;
        captured.markdownProps.length = 0;
        captured.thinkingRowProps.length = 0;
        await act(async () => {
            tree = renderer.create(
                <MessageView
                    message={baseMessage}
                    metadata={null}
                    sessionId="s1"
                    activeThinkingMessageId="m2"
                />,
            );
        });
        expect(captured.thinkingPulseProps.at(-1)?.enabled).toBe(false);
        expect(captured.markdownProps.at(-1)?.textStyle?.fontStyle).toBe('italic');
        expect(tree!.root.findAll((node) => (node.props as any).testID === 'transcript-thinking-body-plain')).toHaveLength(0);
    });
});
