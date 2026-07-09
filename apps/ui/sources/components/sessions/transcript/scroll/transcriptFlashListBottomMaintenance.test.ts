import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptFlashListBottomMaintenance,
    resolveTranscriptFlashListBottomMaintenanceDecision,
} from './transcriptFlashListBottomMaintenance';

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

    it('keeps ordinary released MVCP armed when no live turn can mutate the visual bottom', () => {
        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            bottomFollowMode: 'released',
            liveRegionActive: false,
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

    it('arms the threshold from the given viewport height alone, independent of mount-settle (cold-open deadlock fix)', () => {
        // Inverted follow-bottom cold opens have no JS bottom-pin authority — the MVCP
        // autoscroll threshold is the only thing that pins. The resolver must arm it as
        // soon as it is GIVEN a laid-out viewport height (following + no open transaction),
        // never waiting on a content-height mount-settle window that may not converge while
        // rows measure late on a tall session. Mount-settle is the caller's concern; the
        // resolver depends only on the height it receives.
        expect(resolveTranscriptFlashListBottomMaintenance({
            ...baseParams,
            layoutHeight: 812,
        })).toEqual({
            animateAutoScrollToBottom: false,
            autoscrollToBottomThreshold: 72 / 812,
            startRenderingFromBottom: true,
        });
    });

    describe('native canonical bottom maintenance', () => {
        it('uses the native bottom maintenance threshold while following', () => {
            expect(resolveTranscriptFlashListBottomMaintenance(baseParams)).toEqual({
                animateAutoScrollToBottom: false,
                autoscrollToBottomThreshold: 72 / 600,
                startRenderingFromBottom: true,
            });
        });

        it('keeps MVCP offset correction armed without bottom autoscroll while escaping or released', () => {
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                bottomFollowMode: 'escaping',
            })).toEqual({ startRenderingFromBottom: true });
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                bottomFollowMode: 'released',
            })).toEqual({ startRenderingFromBottom: true });
        });

        it('withholds bottom autoscroll while a viewport transaction is open (plan B3 single-owner rule)', () => {
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                hasOpenViewportTransaction: true,
            })).toEqual({ startRenderingFromBottom: true });
        });

        it('keeps bottom maintenance without autoscroll when pinning or auto-follow is disabled', () => {
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                pinEnabled: false,
            })).toEqual({ startRenderingFromBottom: true });
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                autoFollowWhenPinned: false,
            })).toEqual({ startRenderingFromBottom: true });
        });

        it('does not disable MVCP outside the carve-active released window', () => {
            const modes = ['following', 'escaping', 'released'] as const;
            for (const mode of modes) {
                for (const hasOpenViewportTransaction of [false, true]) {
                    const result = resolveTranscriptFlashListBottomMaintenance({
                        ...baseParams,
                        bottomFollowMode: mode,
                        hasOpenViewportTransaction,
                        liveRegionActive: false,
                    });
                    expect(result).not.toEqual({ disabled: true });
                }
            }
        });

        it('returns undefined on web before native MVCP props are resolved', () => {
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                platformIsWeb: true,
            })).toBeUndefined();
        });

        it('does not emit a zero threshold before layout measurement', () => {
            const result = resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                layoutHeight: 0,
            });

            expect(result).toMatchObject({ startRenderingFromBottom: true });
            expect(result).not.toHaveProperty('autoscrollToBottomThreshold', 0);
        });
    });

    describe('live-region single pin owner (plan §12 #3)', () => {
        // While the native edge-slot carve is active, the JS force-pin owns the visual bottom and
        // MVCP must keep ONLY prepend/top offset correction. Arming the bottom autoscroll threshold
        // here re-introduces a second bottom authority that races the JS pin (the #1 pin-loss). So
        // following + liveRegionActive must withhold the threshold (startRenderingFromBottom only),
        // while following + inactive live region keeps today's threshold branch unchanged.
        it('withholds the bottom autoscroll threshold while following with the live region active', () => {
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                liveRegionActive: true,
            })).toEqual({ startRenderingFromBottom: true });
        });

        it('withholds bottom autoscroll while a target window is active', () => {
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                targetWindowActive: true,
            })).toEqual({ startRenderingFromBottom: true });
        });

        it('keeps the threshold branch unchanged while following with the live region inactive', () => {
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                liveRegionActive: false,
            })).toEqual({
                animateAutoScrollToBottom: false,
                autoscrollToBottomThreshold: 72 / 600,
                startRenderingFromBottom: true,
            });

            // Omitting the flag entirely (existing call sites) behaves exactly like inactive.
            expect(resolveTranscriptFlashListBottomMaintenance(baseParams)).toMatchObject({
                autoscrollToBottomThreshold: 72 / 600,
            });
        });

        it('keeps the native MVCP prop stable while pausing JS offset correction for released carve windows (NQA-F4)', () => {
            // NQA-F4: returning {disabled:true} nulls the native MVCP prop, unmounts FlashList's
            // ScrollAnchor, and lets RN Fabric re-latch against stale 1e6 anchor state. Carve
            // withholding must pause only FlashList's JS correction path.
            expect(resolveTranscriptFlashListBottomMaintenanceDecision({
                ...baseParams,
                bottomFollowMode: 'released',
                liveRegionActive: true,
            })).toEqual({
                maintainVisibleContentPosition: { startRenderingFromBottom: true },
                pauseOffsetCorrection: true,
            });
            expect(resolveTranscriptFlashListBottomMaintenanceDecision({
                ...baseParams,
                bottomFollowMode: 'escaping',
                liveRegionActive: true,
            })).toEqual({
                maintainVisibleContentPosition: { startRenderingFromBottom: true },
                pauseOffsetCorrection: true,
            });
        });

        it('never flaps the native MVCP prop across carve follow/release transitions (NQA-F4)', () => {
            const modes = ['following', 'escaping', 'released'] as const;
            for (const platformIsWeb of [false, true]) {
                for (const liveRegionActive of [false, true]) {
                    for (const bottomFollowMode of modes) {
                        const result = resolveTranscriptFlashListBottomMaintenance({
                            ...baseParams,
                            bottomFollowMode,
                            liveRegionActive,
                            platformIsWeb,
                        });

                        if (platformIsWeb) {
                            expect(result).toBeUndefined();
                            continue;
                        }

                        expect(result).toEqual(expect.objectContaining({
                            startRenderingFromBottom: true,
                        }));
                        expect(result).not.toHaveProperty('disabled');
                    }
                }
            }
        });

        it('keeps MVCP offset-correction ARMED while released during an active turn when the carve is not growing (§3a prepend-preservation)', () => {
            // Regression (§3a): the prior {disabled:true} superset fired for the WHOLE active turn,
            // killing applyOffsetCorrection so an older-page prepend lost reading position
            // (violating Invariant C; inverted older-load has no fallback writer). The disable is
            // now scoped to the carve-active window only — a released reader during an active turn
            // whose carve is NOT growing must keep MVCP armed for prepend preservation.
            expect(resolveTranscriptFlashListBottomMaintenance({
                ...baseParams,
                bottomFollowMode: 'released',
                liveRegionActive: false,
            })).toEqual({ startRenderingFromBottom: true });
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
