// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { CapturingLegendListMockState } from '@/dev/testkit/mocks/legendList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const syncTuningState = vi.hoisted(() => ({
    transcriptEstimatedItemSizePx: 120,
    transcriptBackwardPrefetchThresholdPx: 800,
    transcriptBackwardPrefetchThresholdItems: 12,
    transcriptOlderLoadCooldownMs: 2500,
    transcriptOlderLoadSpinnerDelayMs: 0,
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
    MessageView: (props: Record<string, unknown>) => React.createElement('MessageView', props),
    MessageViewWithSessionCommon: (props: Record<string, unknown>) => React.createElement('MessageViewWithSessionCommon', props),
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock();
    legendListCapture.state = mock.state;
    return mock.module;
});

describe('ChainTranscriptList explicit jump takeover', () => {
    afterEach(standardCleanup);

    it('acquires renderer takeover before older loading and aborts the request on unmount', async () => {
        const { Platform } = await import('react-native');
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const olderLoad = createDeferred<{
            loaded: number;
            hasMore: boolean;
            status: 'loaded';
        }>();
        const loadOlder = vi.fn(() => olderLoad.promise);
        const capture = legendListCapture.state;
        if (!capture) throw new Error('LegendList mock did not initialize');
        capture.refHandle.cancelInitialScrollPreservation.mockClear();
        capture.refHandle.scrollToIndex.mockClear();

        try {
            const screen = await renderScreen(<ChainTranscriptList
                sessionId="sidechain-jump-takeover"
                datasetKey="sidechain:sidechain-jump-takeover:1"
                metadata={null}
                messages={[
                    { kind: 'agent-text', id: 'loaded-message', localId: null, createdAt: 1, text: 'loaded', isThinking: false },
                ]}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                jumpToMessageId="missing-target"
                loadOlder={loadOlder}
            />);

            expect(capture.refHandle.cancelInitialScrollPreservation).toHaveBeenCalledTimes(1);
            expect(loadOlder).toHaveBeenCalledTimes(1);
            expect(capture.refHandle.cancelInitialScrollPreservation.mock.invocationCallOrder[0])
                .toBeLessThan(loadOlder.mock.invocationCallOrder[0]);

            screen.unmount();
            olderLoad.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            await Promise.resolve();
            await Promise.resolve();
            expect(capture.refHandle.scrollToIndex.mock.calls.filter(
                ([params]) => params?.animated === true,
            )).toHaveLength(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});
