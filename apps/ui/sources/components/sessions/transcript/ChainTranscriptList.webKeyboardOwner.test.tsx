// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { CapturingLegendListMockState } from '@/dev/testkit/mocks/legendList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const syncTuningState = vi.hoisted(() => ({
    transcriptEstimatedItemSizePx: 120,
    transcriptBackwardPrefetchThresholdPx: 800,
    transcriptBackwardPrefetchThresholdItems: 12,
    transcriptOlderLoadCooldownMs: 2500,
    transcriptOlderLoadSpinnerDelayMs: 0,
}));

const legendState = vi.hoisted(() => ({
    current: {
        contentLength: 120,
        end: 0,
        endBuffered: 0,
        scroll: 0,
        scrollLength: 120,
        start: 0,
    } as Record<string, unknown>,
}));

const legendListCapture = vi.hoisted(() => ({
    state: null as CapturingLegendListMockState | null,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => syncTuningState,
    },
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSessionCatchingUpNewer: () => false,
    };
});

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => React.createElement('MessageView', props),
    MessageViewWithSessionCommon: (props: any) => React.createElement('MessageViewWithSessionCommon', props),
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock({
        resolveState: () => legendState.current,
    });
    legendListCapture.state = mock.state;
    return mock.module;
});

describe('ChainTranscriptList web keyboard ownership', () => {
    afterEach(() => {
        standardCleanup();
        document.body.replaceChildren();
        legendState.current = {
            contentLength: 120,
            end: 0,
            endBuffered: 0,
            scroll: 0,
            scrollLength: 120,
            start: 0,
        };
    });

    it('selects the sole sidechain from BODY PageUp without prior transcript interaction', async () => {
        const { Platform } = await import('react-native');
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const scroller = document.createElement('div');
        document.body.appendChild(scroller);
        const capture = legendListCapture.state;
        if (!capture) throw new Error('LegendList mock did not initialize');
        capture.refHandle.getScrollableNode.mockReturnValue(scroller);
        const baseProps = {
            sessionId: 'sidechain-document-page-up',
            datasetKey: JSON.stringify(['sidechain-document-page-up', 'sidechain-a']),
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        } as const;

        try {
            const screen = await renderScreen(React.createElement(ChainTranscriptList, {
                ...baseProps,
                messages: [
                    { kind: 'agent-text', id: 'first', localId: null, createdAt: 1, text: 'first', isThinking: false },
                ],
            }));
            capture.refHandle.scrollToIndex.mockClear();

            document.body.tabIndex = -1;
            document.body.focus();
            expect(document.activeElement).toBe(document.body);
            document.body.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true,
                key: 'PageUp',
            }));
            expect(document.activeElement).toBe(scroller);

            legendState.current = {
                ...legendState.current,
                contentLength: 240,
                end: 0,
                endBuffered: 0,
                scrollLength: 120,
            };
            await screen.update(React.createElement(ChainTranscriptList, {
                ...baseProps,
                messages: [
                    { kind: 'agent-text', id: 'first', localId: null, createdAt: 1, text: 'first', isThinking: false },
                    { kind: 'agent-text', id: 'second', localId: null, createdAt: 2, text: 'second', isThinking: false },
                ],
            }));

            expect(capture.refHandle.scrollToIndex).not.toHaveBeenCalled();
        } finally {
            document.body.removeAttribute('tabindex');
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('keeps sidechain held-end maintenance through bottom-clamped PageDown and later growth', async () => {
        const { Platform } = await import('react-native');
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const scroller = document.createElement('div');
        document.body.appendChild(scroller);
        const capture = legendListCapture.state;
        if (!capture) throw new Error('LegendList mock did not initialize');
        capture.refHandle.getScrollableNode.mockReturnValue(scroller);
        legendState.current = {
            contentLength: 120,
            end: 0,
            endBuffered: 0,
            scroll: 0,
            scrollLength: 120,
            start: 0,
        };
        const baseProps = {
            sessionId: 'sidechain-document-page-down',
            datasetKey: JSON.stringify(['sidechain-document-page-down', 'sidechain-a']),
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        } as const;

        try {
            const screen = await renderScreen(React.createElement(ChainTranscriptList, {
                ...baseProps,
                messages: [
                    { kind: 'agent-text', id: 'first', localId: null, createdAt: 1, text: 'first', isThinking: false },
                ],
            }));
            expect(capture.props.maintainScrollAtEnd).toMatchObject({ animated: false });

            act(() => {
                scroller.dispatchEvent(new KeyboardEvent('keydown', {
                    bubbles: true,
                    key: 'PageDown',
                }));
            });

            legendState.current = {
                ...legendState.current,
                contentLength: 240,
                end: 1,
                endBuffered: 1,
                scrollLength: 120,
            };
            await screen.update(React.createElement(ChainTranscriptList, {
                ...baseProps,
                messages: [
                    { kind: 'agent-text', id: 'first', localId: null, createdAt: 1, text: 'first', isThinking: false },
                    { kind: 'agent-text', id: 'second', localId: null, createdAt: 2, text: 'second', isThinking: false },
                ],
            }));

            expect(capture.props.maintainScrollAtEnd).toMatchObject({ animated: false });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});
