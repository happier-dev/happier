import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { AgentTextMessage } from '@/sync/domains/messages/messageTypes';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    markdownProps: [] as Record<string, unknown>[],
    extractMentionsCalls: 0,
    streamingSmoothingEnabled: true,
    streamingPartialEnabled: true,
    streamingMarkdownEnabled: true,
    transcriptMotionConfig: {
        preset: 'subtle',
        freshnessMs: 60_000,
        animateNewItemsEnabled: true,
        animateToolExpandCollapseEnabled: true,
        animateToolExpandCollapseFreshOnly: true,
        animateThinkingEnabled: true,
    } as Record<string, unknown>,
    platformOS: 'web' as 'web' | 'ios' | 'android',
}));

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return captured.platformOS;
                },
                select: (values: Record<string, unknown>) =>
                    values?.[captured.platformOS] ?? values?.default,
            },
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
                React.createElement('Pressable', props, children),
            ActivityIndicator: 'ActivityIndicator',
            Dimensions: {
                get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: {
                        primary: '#f4f4f4',
                    },
                },
            },
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
        return createExpoRouterMock({ router: { push: vi.fn() } }).module;
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
                    if (key === 'transcriptStreamingSmoothingEnabled') return captured.streamingSmoothingEnabled;
                    if (key === 'transcriptStreamingSettleDelayMs') return 200;
                    if (key === 'transcriptStreamingPartialOutputEnabled') return captured.streamingPartialEnabled;
                    if (key === 'transcriptStreamingMarkdownRenderingEnabled') return captured.streamingMarkdownEnabled;
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
    MarkdownView: (props: Record<string, unknown>) => {
        captured.markdownProps.push(props);
        return React.createElement('MarkdownView', props);
    },
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Text', props, props.children),
}));
vi.mock('@/components/tools/shell/views/ToolView', () => ({ ToolView: () => React.createElement('ToolView') }));
vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: () => React.createElement('ToolTimelineRow'),
}));
vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    renderStructuredMessage: () => null,
    StructuredMessageBlock: () => React.createElement('StructuredMessageBlock'),
}));
vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({ shouldShowMessageCopyButton: () => false }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({ isCommittedMessageDiscarded: () => false }));
vi.mock('@/utils/url/sessionFileDeepLink', () => ({ buildSessionFileDeepLink: () => '' }));
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (promise: Promise<unknown>) => promise }));
vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => {
        captured.extractMentionsCalls += 1;
        return [];
    },
}));
vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
    LinkedWorkspaceFilesRow: () => React.createElement('LinkedWorkspaceFilesRow'),
}));
vi.mock('@/components/sessions/transcript/motion/TranscriptMotionContext', () => ({
    useTranscriptMotion: () => ({ config: captured.transcriptMotionConfig }),
}));
vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({
    ThinkingTimelineRow: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('ThinkingTimelineRow', props, props.children),
}));
vi.mock('@/sync/ops', () => ({ forkSession: vi.fn() }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkFromMessage: () => false }));
vi.mock('@/sync/domains/sessionFork/forkFromMessageSemantics', () => ({ resolveForkFromMessageSemantics: () => null }));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ executeAction: vi.fn() }),
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({ readMachineTargetForSession: () => null }));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: vi.fn(async () => true) }));

function createAgentMessage(overrides: Partial<AgentTextMessage> = {}): AgentTextMessage {
    return {
        kind: 'agent-text',
        id: 'm1',
        localId: null,
        createdAt: 1,
        text: 'Hello',
        isThinking: false,
        ...overrides,
    };
}

function flattenTestStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'));
    }
    return style && typeof style === 'object' ? { ...(style as Record<string, unknown>) } : {};
}

describe('MessageView (streaming smoothing)', () => {
    beforeEach(() => {
        captured.markdownProps.length = 0;
        captured.extractMentionsCalls = 0;
        captured.streamingSmoothingEnabled = true;
        captured.streamingPartialEnabled = true;
        captured.streamingMarkdownEnabled = true;
        captured.platformOS = 'web';
        captured.transcriptMotionConfig = {
            preset: 'subtle',
            freshnessMs: 60_000,
            animateNewItemsEnabled: true,
            animateToolExpandCollapseEnabled: true,
            animateToolExpandCollapseFreshOnly: true,
            animateThinkingEnabled: true,
        };
        vi.resetModules();
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('renders streaming Markdown while an agent message is actively streaming then returns to static Markdown after settling', async () => {
        const { MessageView } = await import('./MessageView');
        const baseMessage = createAgentMessage();

        const screen = await renderScreen(
            <MessageView
                message={baseMessage}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(captured.markdownProps).toHaveLength(1);
        captured.markdownProps.length = 0;
        captured.extractMentionsCalls = 0;

        await act(async () => {
            await screen.update(
                <MessageView
                    message={createAgentMessage({ text: 'Hello wor' })}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            vi.advanceTimersByTime(0);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello wor',
            streamingMode: 'streaming',
            streamingAnimated: true,
            streamingRevealPreset: 'subtle',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(captured.extractMentionsCalls).toBe(0);
        captured.markdownProps.length = 0;

        await act(async () => {
            await screen.update(
                <MessageView
                    message={createAgentMessage({ text: 'Hello world!' })}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            vi.advanceTimersByTime(0);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello wor',
            streamingMode: 'streaming',
            streamingAnimated: true,
            streamingRevealPreset: 'subtle',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        captured.markdownProps.length = 0;

        await act(async () => {
            vi.advanceTimersByTime(250);
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(captured.markdownProps).toHaveLength(1);
        expect(captured.markdownProps[0]?.markdown).toBe('Hello world!');
        expect(captured.markdownProps[0]?.streamingMode).toBeUndefined();
        expect(captured.markdownProps[0]?.staticRenderPlaceholderEnabled).toBe(false);
        expect(captured.extractMentionsCalls).toBeGreaterThan(0);
    });

    it('renders an assistant stream segment as streaming Markdown before the first text change', async () => {
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(captured.markdownProps).toHaveLength(1);
        expect(captured.markdownProps[0]).toMatchObject({
            markdown: 'Hello',
            streamingMode: 'streaming',
        });
        expect(captured.extractMentionsCalls).toBe(0);
    });

    it('throttles active streaming Markdown updates without switching to the plain fallback', async () => {
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        await flushHookEffects({ cycles: 2, turns: 2 });
        captured.markdownProps.length = 0;

        await act(async () => {
            await screen.update(
                <MessageView
                    message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello wor', meta: streamingMeta })}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            vi.advanceTimersByTime(0);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello wor',
            streamingMode: 'streaming',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        captured.markdownProps.length = 0;

        await act(async () => {
            await screen.update(
                <MessageView
                    message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello world!', meta: streamingMeta })}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            vi.advanceTimersByTime(0);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello wor',
            streamingMode: 'streaming',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);

        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello world!',
            streamingMode: 'streaming',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
    });

    it('marks active web assistant streaming content as a polite log live region', async () => {
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        const liveRegion = screen.findAllByType('View').find((node) => node.props.role === 'log');

        expect(liveRegion?.props).toMatchObject({
            role: 'log',
            accessibilityLiveRegion: 'polite',
            'aria-live': 'polite',
            'aria-busy': true,
            'aria-atomic': false,
        });
    });

    it('uses the transcript motion preset for streaming reveal animation', async () => {
        captured.transcriptMotionConfig = {
            preset: 'full',
            freshnessMs: 60_000,
            animateNewItemsEnabled: true,
            animateToolExpandCollapseEnabled: true,
            animateToolExpandCollapseFreshOnly: true,
            animateThinkingEnabled: true,
        };
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(captured.markdownProps.at(-1)).toMatchObject({
            streamingMode: 'streaming',
            streamingAnimated: true,
            streamingRevealPreset: 'full',
        });
    });

    it('disables streaming reveal animation when transcript motion disables new item animation', async () => {
        captured.transcriptMotionConfig = {
            preset: 'subtle',
            freshnessMs: 60_000,
            animateNewItemsEnabled: false,
            animateToolExpandCollapseEnabled: true,
            animateToolExpandCollapseFreshOnly: true,
            animateThinkingEnabled: true,
        };
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(captured.markdownProps.at(-1)).toMatchObject({
            streamingMode: 'streaming',
            streamingAnimated: false,
        });
    });

    it('renders active streaming plain text with the themed transcript color', async () => {
        captured.streamingMarkdownEnabled = false;
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        const plain = screen.findByTestId('transcript-streaming-plain:m1');

        expect(flattenTestStyle(plain?.props.style)).toMatchObject({
            color: '#f4f4f4',
        });
    });

    it('keeps historical assistant stream segments on the Markdown rendering path', async () => {
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                historical={true}
            />,
        );

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(captured.markdownProps).toHaveLength(1);
    });

    it('renders the current stream segment text immediately when smoothing is disabled', async () => {
        captured.streamingSmoothingEnabled = false;
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        await act(async () => {
            await screen.update(
                <MessageView
                    message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello world', meta: streamingMeta })}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello world',
            streamingMode: 'streaming',
            streamingAnimated: true,
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
    });

    it('hides partial streaming output when transcript streaming partial output is disabled', async () => {
        captured.streamingPartialEnabled = false;
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello wor', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: '...',
            streamingMode: 'streaming',
        });
    });

    it('keeps the plain streaming fallback when streaming Markdown rendering is disabled', async () => {
        captured.streamingMarkdownEnabled = false;
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello wor', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(screen.findByTestId('transcript-streaming-plain:m1')).not.toBe(null);
        expect(captured.markdownProps).toHaveLength(0);
    });

    it('suppresses the iOS native copy menu for active plain streaming transcript text', async () => {
        captured.platformOS = 'ios';
        captured.streamingMarkdownEnabled = false;
        const { MessageView } = await import('./MessageView');
        const streamingMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        } satisfies AgentTextMessage['meta'];

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello wor', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        const plain = screen.findByTestId('transcript-streaming-plain:m1');
        expect(plain?.props.selectable).toBe(false);
    });
});
