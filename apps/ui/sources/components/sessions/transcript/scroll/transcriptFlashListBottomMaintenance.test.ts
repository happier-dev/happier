import { describe, expect, it } from 'vitest';

import { resolveTranscriptFlashListBottomMaintenance } from './transcriptFlashListBottomMaintenance';

const baseParams = {
    autoFollowWhenPinned: true,
    bottomFollowMode: 'following' as const,
    layoutHeight: 600,
    nativeEntryShouldUseBottomMaintenance: true,
    pinEnabled: true,
    pinThresholdPx: 72,
    platformIsWeb: false,
    hasOpenViewportTransaction: false,
};

describe('transcript FlashList bottom maintenance policy', () => {
    it('returns undefined on web to preserve the web FlashList crash-avoidance path', () => {
        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            platformIsWeb: true,
        })).toBeUndefined();
    });

    it('enables native bottom maintenance with a clamped bottom threshold while following', () => {
        expect(resolveTranscriptFlashListBottomMaintenance(baseParams)).toEqual({
            animateAutoScrollToBottom: false,
            autoscrollToBottomThreshold: 72 / 600,
            startRenderingFromBottom: true,
        });

        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            pinThresholdPx: 900,
        })).toMatchObject({
            autoscrollToBottomThreshold: 1,
        });
    });

    it('does not emit threshold 0 as a pretend disabled state before layout is stable', () => {
        const result = resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            layoutHeight: 0,
        });

        expect(result).toMatchObject({
            startRenderingFromBottom: true,
        });
        expect(result).not.toHaveProperty('autoscrollToBottomThreshold', 0);
    });

    it('keeps MVCP offset correction armed without bottom autoscroll while escaping or released (plan P1)', () => {
        // Prepends happen while released: FlashList key-based applyOffsetCorrection must stay
        // alive so the anchor row holds position (mvcp-preserved, zero writes). Omitting
        // autoscrollToBottomThreshold (FlashList default -1) keeps bottom-stick off.
        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            bottomFollowMode: 'escaping',
        })).toEqual({ startRenderingFromBottom: true });

        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            bottomFollowMode: 'released',
        })).toEqual({ startRenderingFromBottom: true });
    });

    it('keeps the existing unpinned entry-restore policy unless implementation proves a safer disabled object', () => {
        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            nativeEntryShouldUseBottomMaintenance: false,
        })).toBeUndefined();
    });

    it('withholds the bottom autoscroll threshold while a viewport transaction is open (plan B3)', () => {
        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            hasOpenViewportTransaction: true,
        })).toEqual({
            startRenderingFromBottom: true,
        });
    });

    it('does not pass a bottom autoscroll threshold when pinning or auto-follow is disabled', () => {
        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            pinEnabled: false,
        })).toEqual({
            startRenderingFromBottom: true,
        });

        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            autoFollowWhenPinned: false,
        })).toEqual({
            startRenderingFromBottom: true,
        });
    });
});
