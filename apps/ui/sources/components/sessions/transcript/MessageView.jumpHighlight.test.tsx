import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { AgentTextMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reducedMotionState = vi.hoisted(() => ({ value: false }));

installMessageViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        const { createReducer } = await import('@/sync/reducer/reducer');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'transcriptMessageTimestampDisplayMode') return 'never';
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'summary';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    if (key === 'toolViewTimelineChromeMode') return 'cards';
                    return null;
                } }),
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.value,
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('MarkdownView', props, props.children),
}));

vi.mock('@/components/sessions/transcript/transcriptRowActionVisibility', () => ({
    shouldShowTranscriptRowActions: () => false,
    shouldShowTranscriptRowPinAction: () => false,
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: () => null,
}));

vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({
    ThinkingTimelineRow: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsMessageRow', () => ({
    AttachmentsMessageRow: () => null,
}));

vi.mock('@/components/sessions/sessionMedia/SessionMediaInlineImages', () => ({
    SessionMediaInlineImages: () => null,
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

const userMessage: UserTextMessage = {
    kind: 'user-text',
    id: 'u1',
    localId: 'local-u1',
    createdAt: 1,
    text: 'hello',
    seq: 7,
    transcriptBlockIndex: 0,
};

const agentMessage: AgentTextMessage = {
    kind: 'agent-text',
    id: 'a1',
    localId: 'local-a1',
    createdAt: 2,
    text: 'reply',
    seq: 8,
    transcriptBlockIndex: 1,
};

function findOverlaysWithin(row: ReactTestInstance | null, overlayTestId: string): ReactTestInstance[] {
    if (!row) return [];
    return row.findAll((node) => node.props?.testID === overlayTestId && typeof node.type === 'string');
}

function hostParentOf(node: ReactTestInstance): ReactTestInstance | null {
    let current = node.parent;
    while (current && typeof current.type !== 'string') {
        current = current.parent;
    }
    return current ?? null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

/** Highlight fades are the only delayed opacity animation; reveal slots have no delay. */
function jumpFadeCalls(calls: readonly unknown[][]): unknown[][] {
    return calls.filter(([, config]) => {
        const typed = config as { toValue?: number; delay?: number };
        return typed.toValue === 0 && typeof typed.delay === 'number';
    });
}

async function renderTwoRows() {
    const { View } = await import('react-native');
    const { MessageView } = await import('./MessageView');
    return await renderScreen(
        <View>
            <View testID="row-u1">
                <MessageView sessionId="s1" metadata={null} message={userMessage} />
            </View>
            <View testID="row-a1">
                <MessageView sessionId="s1" metadata={null} message={agentMessage} />
            </View>
        </View>,
    );
}

describe('MessageView jump landing highlight', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        reducedMotionState.value = false;
    });

    afterEach(async () => {
        const { clearTranscriptJumpHighlight } = await import('./navigation/transcriptJumpHighlightStore');
        await act(async () => {
            clearTranscriptJumpHighlight();
        });
        vi.useRealTimers();
        standardCleanup();
    });

    it('highlights only the jump target row (routeMessageId identity) and expires after the canonical duration', async () => {
        const { applyTranscriptJumpHighlightForJumpResult, TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS } =
            await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const screen = await renderTwoRows();

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'local:local-u1', seqHint: 7 },
            });
        });

        expect(findOverlaysWithin(screen.findByTestId('row-u1'), TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(1);
        expect(findOverlaysWithin(screen.findByTestId('row-a1'), TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);

        await act(async () => {
            vi.advanceTimersByTime(TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS);
        });

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);
    });

    it('paints the highlight on the message element itself, not the full-width centring row', async () => {
        const { applyTranscriptJumpHighlightForJumpResult } =
            await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const screen = await renderTwoRows();

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'local:local-u1', seqHint: 7 },
            });
        });

        const ring = findOverlaysWithin(screen.findByTestId('row-u1'), TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)[0];
        expect(ring).toBeTruthy();
        expect(flattenStyle(ring.props.style).borderRadius).toBe(12);

        // The user bubble owns the highlight; the full-width wrapper that centres it
        // (no padding, no radius) must not be the painted surface.
        const bubbleStyle = flattenStyle(hostParentOf(ring)?.props.style);
        expect(bubbleStyle.borderRadius).toBe(12);
        expect(bubbleStyle.paddingHorizontal).toBe(14);
    });

    it('paints the agent block highlight on the agent message element', async () => {
        const { applyTranscriptJumpHighlightForJumpResult } =
            await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const screen = await renderTwoRows();

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'local:local-a1', seqHint: 8 },
            });
        });

        const ring = findOverlaysWithin(screen.findByTestId('row-a1'), TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)[0];
        expect(ring).toBeTruthy();
        expect(flattenStyle(ring.props.style).borderRadius).toBe(16);
        expect(flattenStyle(hostParentOf(ring)?.props.style).marginHorizontal).toBe(16);
    });

    it('highlights via seq fallback identity for seq-kind jump targets', async () => {
        const { applyTranscriptJumpHighlightForJumpResult } =
            await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const screen = await renderTwoRows();

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'window-rendered',
                target: { kind: 'seq', seq: 8 },
                windowId: 'w-1',
            });
        });

        expect(findOverlaysWithin(screen.findByTestId('row-a1'), TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(1);
        expect(findOverlaysWithin(screen.findByTestId('row-u1'), TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);
    });

    it('fades out via a delayed opacity animation when motion is allowed', async () => {
        const { Animated } = await import('react-native');
        const timingSpy = vi.spyOn(Animated, 'timing');
        const {
            applyTranscriptJumpHighlightForJumpResult,
            TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS,
            TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS,
        } = await import('./navigation/transcriptJumpHighlightStore');
        const screen = await renderTwoRows();

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'local:local-u1' },
            });
        });

        const fadeCalls = jumpFadeCalls(timingSpy.mock.calls);
        expect(fadeCalls).toHaveLength(1);
        expect((fadeCalls[0][1] as { duration?: number }).duration).toBe(TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS);
        expect((fadeCalls[0][1] as { delay?: number }).delay).toBe(
            TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS - TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS,
        );
        expect(screen.findAllByTestId('transcript-jump-highlight').length).toBeGreaterThan(0);
        timingSpy.mockRestore();
    });

    it('renders a static highlight without a fade animation when reduced motion is preferred', async () => {
        reducedMotionState.value = true;
        const { Animated } = await import('react-native');
        const timingSpy = vi.spyOn(Animated, 'timing');
        const { applyTranscriptJumpHighlightForJumpResult, TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS } =
            await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const screen = await renderTwoRows();

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'local:local-u1' },
            });
        });

        expect(findOverlaysWithin(screen.findByTestId('row-u1'), TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(1);
        expect(jumpFadeCalls(timingSpy.mock.calls)).toHaveLength(0);

        await act(async () => {
            vi.advanceTimersByTime(TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS);
        });

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);
        timingSpy.mockRestore();
    });
});
