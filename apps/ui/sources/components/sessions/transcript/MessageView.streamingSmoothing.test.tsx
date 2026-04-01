import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    markdownProps: [] as any[],
    extractMentionsCalls: 0,
    streamingPartialEnabled: true,
}));

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ActivityIndicator: 'ActivityIndicator',
            Dimensions: {
                get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
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
                    if (key === 'transcriptStreamingSmoothingEnabled') return true;
                    if (key === 'transcriptStreamingSettleDelayMs') return 200;
                    if (key === 'transcriptStreamingPartialOutputEnabled') return captured.streamingPartialEnabled;
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
vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => {
        captured.extractMentionsCalls += 1;
        return [];
    },
}));
vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({ LinkedWorkspaceFilesRow: () => React.createElement('LinkedWorkspaceFilesRow') }));
vi.mock('@/components/sessions/transcript/motion/TranscriptMotionContext', () => ({ useTranscriptMotion: () => null }));
vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({ ThinkingTimelineRow: (props: any) => React.createElement('ThinkingTimelineRow', props, props.children) }));
vi.mock('@/sync/ops', () => ({ forkSession: vi.fn() }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkFromMessage: () => false }));
vi.mock('@/sync/domains/sessionFork/forkFromMessageSemantics', () => ({ resolveForkFromMessageSemantics: () => null }));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({ createDefaultActionExecutor: () => ({ executeAction: vi.fn() }) }));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({ readMachineTargetForSession: () => null }));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: vi.fn(async () => true) }));

describe('MessageView (streaming smoothing)', () => {
    beforeEach(() => {
        captured.markdownProps.length = 0;
        captured.extractMentionsCalls = 0;
        captured.streamingPartialEnabled = true;
        vi.resetModules();
        vi.useFakeTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('renders plain text while an agent message is actively streaming, then switches back to MarkdownView after settling', async () => {
        const { MessageView } = await import('./MessageView');

        const baseMessage = {
            kind: 'agent-text' as const,
            id: 'm1',
            localId: null,
            createdAt: 1,
            text: 'Hello',
            isThinking: false,
            meta: undefined,
        };

        const screen = await renderScreen(
            <MessageView
                message={baseMessage as any}
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
                    message={{ ...baseMessage, text: 'Hello wor' } as any}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(captured.markdownProps).toHaveLength(0);
        expect(screen.findByTestId('transcript-streaming-plain:m1')).not.toBe(null);
        expect(captured.extractMentionsCalls).toBe(0);

        await act(async () => {
            await screen.update(
                <MessageView
                    message={{ ...baseMessage, text: 'Hello world!' } as any}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(captured.markdownProps).toHaveLength(0);
        expect(screen.findByTestId('transcript-streaming-plain:m1')).not.toBe(null);

        await act(async () => {
            vi.advanceTimersByTime(250);
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(captured.markdownProps).toHaveLength(1);
        expect(captured.markdownProps[0]?.markdown).toBe('Hello world!');
        expect(captured.extractMentionsCalls).toBeGreaterThan(0);
    });

    it('switches back to MarkdownView immediately when transcript-vNext stream segments report completion', async () => {
        const { MessageView } = await import('./MessageView');

        const baseMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        };

        const baseMessage = {
            kind: 'agent-text' as const,
            id: 'm1',
            localId: 'assistant-segment-1',
            createdAt: 1,
            text: 'Hello',
            isThinking: false,
            meta: baseMeta,
        };

        const screen = await renderScreen(
            <MessageView
                message={baseMessage as any}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        captured.markdownProps.length = 0;

        await act(async () => {
            await screen.update(
                <MessageView
                    message={{ ...baseMessage, text: 'Hello wor', meta: baseMeta } as any}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('transcript-streaming-plain:m1')).not.toBe(null);
        expect(captured.markdownProps).toHaveLength(0);

        const finalMeta = {
            happierStreamSegmentV1: {
                ...baseMeta.happierStreamSegmentV1,
                segmentState: 'complete',
                updatedAtMs: 2_000,
            },
        };

        await act(async () => {
            await screen.update(
                <MessageView
                    message={{ ...baseMessage, text: 'Hello world!', meta: finalMeta } as any}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(captured.markdownProps.length).toBeGreaterThan(0);
        expect(captured.markdownProps[captured.markdownProps.length - 1]?.markdown).toBe('Hello world!');
    });

    it('hides partial streaming output when transcript streaming partial output is disabled', async () => {
        captured.streamingPartialEnabled = false;
        const { MessageView } = await import('./MessageView');

        const baseMeta = {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'assistant-segment-1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_000,
            },
        };

        const baseMessage = {
            kind: 'agent-text' as const,
            id: 'm1',
            localId: 'assistant-segment-1',
            createdAt: 1,
            text: 'Hello',
            isThinking: false,
            meta: baseMeta,
        };

        const screen = await renderScreen(
            <MessageView
                message={baseMessage as any}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        await act(async () => {
            await screen.update(
                <MessageView
                    message={{ ...baseMessage, text: 'Hello wor', meta: baseMeta } as any}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const plain = screen.findByTestId('transcript-streaming-plain:m1');
        expect(plain).not.toBe(null);
        expect((plain as any).props.children).toBe('…');
    });
});
