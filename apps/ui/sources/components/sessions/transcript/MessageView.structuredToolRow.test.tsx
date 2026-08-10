import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toggleToolPinSpy = vi.fn<(pin: PersistedSessionMessagePinV1) => void>();

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
                useSetting: (key: string) => {
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    // Suppressed tool chrome: the structured node is the whole row.
                    if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                    return null;
                },
                useSession: () => null,
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('MarkdownView', props, props.children),
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => React.createElement('StructuredNode', { testID: 'structured-node' }),
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

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function readOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

const structuredToolMessage = {
    kind: 'tool-call',
    id: 'm1',
    localId: 'local-m1',
    realID: 'server-m1',
    createdAt: 1,
    seq: 11,
    transcriptBlockIndex: 3,
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
} as unknown as ToolCallMessage;

async function renderStructuredToolRow() {
    const { MessageView } = await import('./MessageView');
    return renderScreen(
        <MessageView
            sessionId="s1"
            metadata={null}
            message={structuredToolMessage}
            messagePins={[]}
            onToggleToolPin={toggleToolPinSpy}
        />,
    );
}

describe('MessageView structured-only tool row', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        toggleToolPinSpy.mockReset();
    });

    afterEach(async () => {
        const { clearTranscriptJumpHighlight } = await import('./navigation/transcriptJumpHighlightStore');
        await act(async () => {
            clearTranscriptJumpHighlight();
        });
        vi.useRealTimers();
        standardCleanup();
    });

    it('reveals the hidden pin when keyboard focus reaches it, before it can be activated', async () => {
        const screen = await renderStructuredToolRow();

        const slot = () => screen.findByTestId('transcript-tool-call-pin-slot:m1');
        expect(screen.findByTestId('structured-node')).toBeTruthy();
        expect(readOpacity(slot()?.props.style)).toBe(0);

        await act(async () => {
            slot()?.props.onFocus?.();
        });

        expect(readOpacity(slot()?.props.style)).toBe(1);
        expect(flattenStyle(slot()?.props.style).pointerEvents).toBe('auto');

        await act(async () => {
            screen.findByTestId('transcript-tool-call-pin:m1')?.props.onPress?.();
        });

        expect(toggleToolPinSpy).toHaveBeenCalledTimes(1);
    });

    it('paints the jump-landing attention treatment when the jump lands on it', async () => {
        const { applyTranscriptJumpHighlightForJumpResult, TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS } =
            await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const screen = await renderStructuredToolRow();

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'scrolled',
                target: { kind: 'route-message-id', routeMessageId: 'server:server-m1', seqHint: 11 },
            });
        });

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(1);

        await act(async () => {
            vi.advanceTimersByTime(TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS);
        });

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(0);
    });

    it('paints the jump-landing attention treatment via the seq fallback identity', async () => {
        const { applyTranscriptJumpHighlightForJumpResult } = await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const screen = await renderStructuredToolRow();

        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'window-rendered',
                target: { kind: 'seq', seq: 11 },
                windowId: 'w-1',
            });
        });

        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(1);
    });
});
