import { describe, expect, it } from 'vitest';

import { resolveMainTranscriptRendererFrameHost } from './mainTranscriptRendererFrameHost';

const baseParams = {
    autoFollowWhenPinned: true,
    bottomFollowMode: 'following' as const,
    configuredDrawDistance: undefined,
    hasOpenViewportTransaction: false,
    layoutHeight: 600,
    liveRegionActive: false,
    nativeEntryShouldUseBottomMaintenance: true,
    nativeID: 'main-transcript-native-id',
    pinEnabled: true,
    pinThresholdPx: 72,
    platformOS: 'ios',
};

describe('main transcript renderer frame host', () => {
    it('omits MVCP and native drawDistance on web', () => {
        const host = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            platformOS: 'web',
        });

        expect(host.frame).toMatchObject({
            dataOrder: 'oldest-first',
            rendererOptions: {
                flashList: {
                    drawDistance: undefined,
                    inverted: false,
                    maintainVisibleContentPosition: undefined,
                    nativeID: 'main-transcript-native-id',
                },
                legend: {
                    maintainScrollAtEndThreshold: 72 / 600,
                },
            },
        });
        expect(host.maintainVisibleContentPosition).toBeUndefined();
        expect(host.telemetryMvcpPolicy).toBe('none');
    });

    it('arms native MVCP threshold while following and hands it to the main shell frame', () => {
        const host = resolveMainTranscriptRendererFrameHost(baseParams);

        expect(host.maintainVisibleContentPosition).toEqual({
            animateAutoScrollToBottom: false,
            autoscrollToBottomThreshold: 72 / 600,
            startRenderingFromBottom: true,
        });
        expect(host.frame).toMatchObject({
            dataOrder: 'newest-first',
            rendererOptions: {
                flashList: {
                    drawDistance: 600,
                    inverted: true,
                    maintainVisibleContentPosition: host.maintainVisibleContentPosition,
                    nativeID: 'main-transcript-native-id',
                },
                legend: {
                    maintainScrollAtEndThreshold: 72 / 600,
                },
            },
        });
        expect(host.telemetryMvcpPolicy).toBe('autoscroll-threshold');
    });

    it('keeps native offset correction armed without threshold while released or escaping when no carve is active', () => {
        for (const bottomFollowMode of ['released', 'escaping'] as const) {
            const host = resolveMainTranscriptRendererFrameHost({
                ...baseParams,
                bottomFollowMode,
            });

            expect(host.maintainVisibleContentPosition).toEqual({
                startRenderingFromBottom: true,
            });
            expect(host.frame.rendererOptions.flashList.maintainVisibleContentPosition)
                .toBe(host.maintainVisibleContentPosition);
            expect(host.telemetryMvcpPolicy).toBe('start-rendering-from-bottom');
        }
    });

    it('withholds the native bottom threshold while following with an active live-region carve', () => {
        const host = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            liveRegionActive: true,
        });

        expect(host.maintainVisibleContentPosition).toEqual({
            startRenderingFromBottom: true,
        });
        expect(host.frame.rendererOptions.flashList.maintainVisibleContentPosition)
            .toBe(host.maintainVisibleContentPosition);
        expect(host.telemetryMvcpPolicy).toBe('start-rendering-from-bottom');
    });

    it('keeps native MVCP stable and pauses only JS offset correction while released with an active live-region carve (NQA-F4)', () => {
        const host = resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            bottomFollowMode: 'released',
            liveRegionActive: true,
        });

        // NQA-F4: the native MVCP object must not flap to {disabled:true}; the carve release
        // window is represented by a separate FlashList JS correction pause flag.
        expect(host.maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });
        expect(host.frame.rendererOptions.flashList.maintainVisibleContentPosition)
            .toBe(host.maintainVisibleContentPosition);
        expect(host.frame.rendererOptions.flashList.pauseOffsetCorrection).toBe(true);
        expect(host.telemetryMvcpPolicy).toBe('start-rendering-from-bottom');
    });

    it('keeps explicit native drawDistance unchanged and otherwise uses the clamped viewport default', () => {
        expect(resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            configuredDrawDistance: 1600,
            layoutHeight: 800,
        }).frame.rendererOptions.flashList.drawDistance).toBe(1600);

        expect(resolveMainTranscriptRendererFrameHost({
            ...baseParams,
            layoutHeight: 2400,
        }).frame.rendererOptions.flashList.drawDistance).toBe(1200);
    });
});
