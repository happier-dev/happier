import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestSessionTranscriptSource, flushHookEffects, renderWithSessionTranscriptSource as renderSourceScreen, standardCleanup, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import type { AgentTextMessage } from "@happier-dev/session-core/messages";
import { getStorage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { TranscriptMotionProvider } from './motion/TranscriptMotionProvider';
import type { TranscriptMotionConfig } from './motion/TranscriptMotionContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    markdownProps: [] as Record<string, unknown>[],
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
    } as TranscriptMotionConfig,
    platformOS: 'web' as 'web' | 'ios' | 'android',
}));

vi.mock('react-native', async () => {
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
});
vi.mock('react-native-unistyles', async () => {
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
});
vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
});
vi.mock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
});
vi.mock('expo-router', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: vi.fn() } }).module;
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
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
        return Object.assign({}, ...style.map(flattenTestStyle));
    }
    return style && typeof style === 'object' ? { ...(style as Record<string, unknown>) } : {};
}

let currentTree: renderer.ReactTestRenderer | Awaited<ReturnType<typeof renderSourceScreen>> | null = null;
Object.defineProperty(captured, 'markdownProps', { get: () => {
    if (!currentTree) return [];
    const rows = currentTree.root.findAll(node => node.type === MarkdownView
        || ('type' in MarkdownView && node.type === MarkdownView.type));
    return rows.map(row => row.props);
} });
function applyTranscriptSettings() {
    getStorage().setState({ settings: { ...settingsDefaults,
        sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full', sessionThinkingInlineChrome: 'plain',
        transcriptStreamingSmoothingEnabled: captured.streamingSmoothingEnabled, transcriptStreamingSettleDelayMs: 200,
        transcriptStreamingPartialOutputEnabled: captured.streamingPartialEnabled,
        transcriptStreamingMarkdownRenderingEnabled: captured.streamingMarkdownEnabled } });
}
function withMotion(element: React.ReactElement) {
    return <TranscriptMotionProvider sessionKey="s1" config={captured.transcriptMotionConfig}>{element}</TranscriptMotionProvider>;
}
async function renderScreen(element: React.ReactElement) {
    applyTranscriptSettings();
    const screen = await renderSourceScreen(withMotion(element));
    currentTree = screen;
    const update = screen.update;
    Object.assign(screen, { update: async (nextElement: React.ReactElement) => {
        await act(async () => { applyTranscriptSettings(); });
        await update(withMotion(nextElement));
    } });
    return screen;
}

// Load the genuine Sync and row graph before each case's virtual clock begins.
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
await import('./MessageView');


describe('MessageView (streaming smoothing)', () => {
    let previousStore: ReturnType<ReturnType<typeof getStorage>['getState']>;
    beforeEach(() => {
        previousStore = getStorage().getState();
        currentTree = null;
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
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        currentTree = null;
        getStorage().setState(previousStore, true);
    });

    it('records streaming Markdown placeholder history only after the same-message render commits', async () => {
        const { MessageView } = await import('./MessageView');
        const interaction = { canSendMessages: true, canApprovePermissions: true };
        const staticMessage = createAgentMessage();
        const streamingMessage = createAgentMessage({
            localId: 'assistant-segment-1',
            meta: {
                happierStreamSegmentV1: {
                    v: 1,
                    segmentKind: 'assistant',
                    segmentLocalId: 'assistant-segment-1',
                    segmentState: 'streaming',
                    startedAtMs: 1_000,
                    updatedAtMs: 1_000,
                },
            },
        });
        const neverSettles = new Promise<never>(() => {});
        const SuspendAfterRow = (props: Readonly<{ shouldSuspend: boolean }>) => {
            if (props.shouldSuspend) throw neverSettles;
            return null;
        };
        const source = createTestSessionTranscriptSource();
        applyTranscriptSettings();
        const renderMessage = (message: AgentTextMessage, shouldSuspend = false) => withMotion(wrapWithSessionTranscriptSource(
            <React.Suspense fallback={null}>
                <MessageView
                    message={message}
                    metadata={null}
                    sessionId="s1"
                    interaction={interaction}
                />
                <SuspendAfterRow shouldSuspend={shouldSuspend} />
            </React.Suspense>, source,
        ));
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            currentTree = tree = renderer.create(renderMessage(staticMessage), {
                unstable_isConcurrent: true,
            } as unknown as renderer.TestRendererOptions);
        });
        expect(captured.markdownProps.at(-1)?.staticRenderPlaceholderEnabled).toBeUndefined();

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderMessage(streamingMessage, true));
            });
            await Promise.resolve();
        });
        await act(async () => {
            tree.update(renderMessage({ ...staticMessage }));
        });
        expect(captured.markdownProps.at(-1)?.staticRenderPlaceholderEnabled).toBeUndefined();

        await act(async () => {
            tree.update(renderMessage(streamingMessage));
        });
        await act(async () => {
            tree.update(renderMessage({ ...staticMessage }));
        });
        expect(captured.markdownProps.at(-1)?.staticRenderPlaceholderEnabled).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });

    it('paces appended streaming text instead of jumping, then returns to static Markdown after settling', async () => {
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

        // The appended suffix is paced: immediately after the update the reveal
        // cursor still trails, so only the previously shown prefix renders.
        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello',
            streamingMode: 'streaming',
            streamingAnimated: true,
            streamingRevealPreset: 'subtle',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);

        // With no further input the backlog drains and the message settles back
        // to the static Markdown path with the complete text.
        await act(async () => {
            vi.advanceTimersByTime(2000);
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        const settled = captured.markdownProps.at(-1);
        expect(settled?.markdown).toBe('Hello wor');
        expect(settled?.streamingMode).toBeUndefined();
        expect(settled?.staticRenderPlaceholderEnabled).toBe(false);
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
    });

    it('reveals active streaming Markdown progressively without switching to the plain fallback', async () => {
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

        const fullText = 'Hello world! And an appended continuation with several more streamed words to pace.';

        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', text: 'Hello', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            await screen.update(
                <MessageView
                    message={createAgentMessage({ localId: 'assistant-segment-1', text: fullText, meta: streamingMeta })}
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

        // Immediately after the update only the previous prefix is shown.
        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello',
            streamingMode: 'streaming',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);

        // The reveal grows monotonically frame over frame instead of jumping.
        const observed: string[] = [];
        for (let step = 0; step < 12; step += 1) {
            await act(async () => {
                vi.advanceTimersByTime(150);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
            const markdown = captured.markdownProps.at(-1)?.markdown;
            if (typeof markdown === 'string') observed.push(markdown);
        }
        for (let index = 1; index < observed.length; index += 1) {
            expect(observed[index]!.startsWith(observed[index - 1]!)).toBe(true);
        }
        expect(observed.some((markdown) => markdown.length > 'Hello'.length && markdown.length < fullText.length)).toBe(true);

        // The full text is reached while remaining on the streaming Markdown path.
        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: fullText,
            streamingMode: 'streaming',
        });
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
    });

    it('paces streaming thinking text through the same reveal instead of jumping', async () => {
        const { MessageView } = await import('./MessageView');
        const baseThinking = createAgentMessage({ isThinking: true, text: 'Considering the request' });

        const screen = await renderScreen(
            <MessageView
                message={baseThinking}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            await screen.update(
                <MessageView
                    message={createAgentMessage({
                        isThinking: true,
                        text: 'Considering the request and weighing several alternatives before answering.',
                    })}
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

        // The appended thinking suffix is paced exactly like assistant text:
        // right after the update only the previous prefix renders.
        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Considering the request',
            streamingMode: 'streaming',
        });

        await act(async () => {
            vi.advanceTimersByTime(2000);
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        const settled = captured.markdownProps.at(-1);
        expect(settled?.markdown).toBe('Considering the request and weighing several alternatives before answering.');
        expect(settled?.streamingMode).toBeUndefined();
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

    it('bypasses character pacing entirely when the effective transcript motion preset is off', async () => {
        captured.transcriptMotionConfig = {
            preset: 'off',
            freshnessMs: 60_000,
            animateNewItemsEnabled: false,
            animateToolExpandCollapseEnabled: false,
            animateToolExpandCollapseFreshOnly: false,
            animateThinkingEnabled: false,
        };
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

        await screen.update(
            <MessageView
                message={createAgentMessage({ text: 'Hello, immediately.' })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(captured.markdownProps.at(-1)).toMatchObject({
            markdown: 'Hello, immediately.',
        });
        expect(captured.markdownProps.at(-1)?.streamingMode).toBeUndefined();
    });

    it('renders the active plain streaming fallback immediately when effective motion is off', async () => {
        captured.streamingMarkdownEnabled = false;
        captured.transcriptMotionConfig = {
            preset: 'off',
            freshnessMs: 60_000,
            animateNewItemsEnabled: false,
            animateToolExpandCollapseEnabled: false,
            animateToolExpandCollapseFreshOnly: false,
            animateThinkingEnabled: false,
        };
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
        const { MessageView } = await import('./MessageView');
        const screen = await renderScreen(
            <MessageView
                message={createAgentMessage({ localId: 'assistant-segment-1', meta: streamingMeta })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        await screen.update(
            <MessageView
                message={createAgentMessage({
                    localId: 'assistant-segment-1',
                    meta: streamingMeta,
                    text: 'Hello, immediately.',
                })}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        const plain = screen.findByTestId('transcript-streaming-plain:m1');
        if (!plain) throw new Error('Expected the active plain streaming transcript row');
        expect(plain.findByProps({ text: 'Hello, immediately.' })).toBeTruthy();
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
