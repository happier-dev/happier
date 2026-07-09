import { describe, expect, it, vi } from 'vitest';

import { performNativeStandardListViewportCommand } from './nativeStandardList';
import type { TranscriptViewportDriverDeps } from './types';

function buildDeps(): Readonly<{
    deps: TranscriptViewportDriverDeps;
    offsetCalls: Array<{ animated?: boolean; offset: number }>;
    endCalls: Array<{ animated?: boolean } | undefined>;
}> {
    const offsetCalls: Array<{ animated?: boolean; offset: number }> = [];
    const endCalls: Array<{ animated?: boolean } | undefined> = [];
    const deps: TranscriptViewportDriverDeps = {
        listRef: {
            current: {
                transcriptViewportCommandSpace: 'standard',
                scrollToEnd: (params?: { animated?: boolean }) => {
                    endCalls.push(params);
                },
                scrollToIndex: vi.fn(),
                scrollToOffset: (params: { animated?: boolean; offset: number }) => {
                    offsetCalls.push(params);
                },
            },
        },
        listContentHeightRef: { current: 1_200 },
        listLayoutHeightRef: { current: 500 },
        listDataRef: { current: { length: 5 } },
        itemsRef: { current: { length: 5 } },
        composerInsetHeightRef: { current: 0 },
        nativeHotTailHeightRef: { current: 0 },
        lastPinOffsetForIntentRef: { current: null },
        lastNativePinOffsetRef: { current: 140 },
        webDomObservation: {
            getState: () => ({
                observedClientHeight: null,
                observedScrollHeight: null,
                observedScrollTop: null,
                streak: null,
            }),
            observeGenuineScrollMovement: vi.fn(() => ({
                direction: null,
                downwardIntent: false,
                isGenuineUserMovement: false,
                movedSinceLastObservation: false,
                nextStreak: null,
                upwardIntent: false,
            })),
            recordProgrammaticScrollTopWrite: vi.fn(() => ({
                landedScrollHeight: 0,
                landedScrollTop: 0,
                ok: true,
            })),
            reset: vi.fn(),
        },
        lastNativeRestoreIndexCommandRef: { current: null },
        nativeMountSettleStable: true,
        telemetryPlatform: 'ios',
        shouldUseNativeHotColdSplit: false,
        webHotColdCountsRef: { current: { coldCount: 0, hotCount: 0 } },
        clearWebPrependRangeReserve: vi.fn(),
        resolveRestoreAnchorIndex: () => null,
        resolveJumpToSeqIndex: () => null,
        resolveWebScrollMetrics: () => null,
        recordViewportTelemetryEvent: vi.fn(),
        recordRestoreDecisionTelemetry: vi.fn(),
        resolveWebViewportTelemetryDiagnostics: () => ({}),
        resolveInvertedBottomPinCarveTelemetryFields: () => ({}),
    };
    return { deps, endCalls, offsetCalls };
}

describe('native standard list viewport driver', () => {
    it('pins to the shell-measured end offset instead of delegating to renderer scrollToEnd', () => {
        const { deps, endCalls, offsetCalls } = buildDeps();

        const accepted = performNativeStandardListViewportCommand({
            kind: 'pin-bottom',
            sessionId: 'session-a',
            reason: 'jump-to-bottom',
            mode: 'jump-to-bottom',
            contentHeight: 4_800,
            layoutHeight: 700,
            animated: true,
        }, deps);

        expect(accepted).toBe(true);
        expect(endCalls).toEqual([]);
        expect(offsetCalls).toEqual([{ offset: 4_100, animated: true }]);
    });
});
