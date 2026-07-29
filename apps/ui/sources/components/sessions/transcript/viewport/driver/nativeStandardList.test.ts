import { describe, expect, it, vi } from 'vitest';

import { performNativeStandardListViewportCommand } from './nativeStandardList';
import type { TranscriptViewportDriverDeps } from './types';

function buildDeps(): Readonly<{
    deps: TranscriptViewportDriverDeps;
    offsetCalls: Array<{ animated?: boolean; offset: number }>;
    endCalls: Array<{ animated?: boolean } | undefined>;
    scrollToIndex: ReturnType<typeof vi.fn>;
}> {
    const offsetCalls: Array<{ animated?: boolean; offset: number }> = [];
    const endCalls: Array<{ animated?: boolean } | undefined> = [];
    const scrollToIndex = vi.fn();
    const deps: TranscriptViewportDriverDeps = {
        listRef: {
            current: {
                scrollToEnd: (params?: { animated?: boolean }) => {
                    endCalls.push(params);
                },
                scrollToIndex,
                scrollToOffset: (params: { animated?: boolean; offset: number }) => {
                    offsetCalls.push(params);
                },
            },
        },
        listContentHeightRef: { current: 1_200 },
        listLayoutHeightRef: { current: 500 },
        listDataRef: { current: { length: 5 } },
        lastPinOffsetForIntentRef: { current: null },
        webDomObservation: {
            getState: () => ({
                observedClientHeight: null,
                observedScrollHeight: null,
                observedScrollTop: null,
                streak: null,
            }),
            invalidateUserMovementAuthority: vi.fn(),
            observeGenuineScrollMovement: vi.fn<
                TranscriptViewportDriverDeps['webDomObservation']['observeGenuineScrollMovement']
            >(() => ({
                atEndPublicationCause: 'layout',
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
            recordUserScrollInput: vi.fn(),
            reset: vi.fn(),
        },
        lastNativeRestoreIndexCommandRef: { current: null },
        nativeMountSettleStable: true,
        telemetryPlatform: 'ios',
        resolveRendererDataTarget: () => null,
        resolveWebScrollMetrics: () => null,
        recordViewportTelemetryEvent: vi.fn(),
        recordRestoreDecisionTelemetry: vi.fn(),
        resolveWebViewportTelemetryDiagnostics: () => ({}),
    };
    return { deps, endCalls, offsetCalls, scrollToIndex };
}

describe('native standard list viewport driver', () => {
    it('routes bottom intent through the renderer-owned semantic end command', () => {
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
        expect(endCalls).toEqual([{ animated: true }]);
        expect(offsetCalls).toEqual([]);
    });

    it('tags a native entry anchor command for the renderer placement lifecycle', () => {
        const { deps, scrollToIndex } = buildDeps();
        const anchor = {
            itemId: 'row-2',
            itemOffsetPx: 40,
            kind: 'item' as const,
            messageId: null,
        };
        const depsWithTarget = {
            ...deps,
            resolveRendererDataTarget: vi.fn(() => ({
                kind: 'data' as const,
                index: 2,
                itemId: 'row-42',
            })),
        };

        const accepted = performNativeStandardListViewportCommand({
            animated: false,
            kind: 'restore-anchor',
            mode: 'restore-anchor',
            reason: 'entry-restore',
            sessionId: 'session-a',
            target: {
                anchor,
                itemOffsetPx: 40,
            },
        }, depsWithTarget);

        expect(accepted).toBe(true);
        expect(scrollToIndex).toHaveBeenCalledWith({
            animated: false,
            context: {
                anchor: {
                    ...anchor,
                    reason: 'entry-restore',
                },
                kind: 'entry-placement',
            },
            index: 2,
            viewOffset: 40,
        });
    });
});
