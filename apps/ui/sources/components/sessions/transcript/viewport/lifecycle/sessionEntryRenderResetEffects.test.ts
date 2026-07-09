import { describe, expect, it } from 'vitest';

import {
    createTranscriptViewportLifecycle,
    type TranscriptViewportLifecycleEffect,
} from './lifecycle';
import {
    resolveSessionEntryRenderResetEffects,
} from './sessionEntryRenderResetEffects';

function sessionEntryEffects(params: Readonly<{
    platform: 'native' | 'web';
    sessionId?: string;
    shouldFollowLiveTail: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    return createTranscriptViewportLifecycle().dispatch({
        platform: params.platform,
        sessionId: params.sessionId ?? 'session-a',
        shouldFollowLiveTail: params.shouldFollowLiveTail,
        type: 'session-entry',
    }).effects;
}

describe('session-entry render-reset effect selector', () => {
    it('resolves every native follow-bottom render reset effect', () => {
        const resolved = resolveSessionEntryRenderResetEffects({
            effects: sessionEntryEffects({
                platform: 'native',
                shouldFollowLiveTail: true,
            }),
            platform: 'native',
            sessionId: 'session-a',
        });

        expect(resolved.platform).toBe('native');
        if (resolved.platform !== 'native') {
            throw new Error('expected native session-entry render-reset effects');
        }
        expect(resolved.webDomObservationReset.type).toBe('session-entry-web-dom-observation-reset');
        expect(resolved.nativeBottomPinCommandCacheReset.type)
            .toBe('session-entry-native-bottom-pin-command-cache-reset');
        expect(resolved.nativeGestureMomentumMirrorReset.type)
            .toBe('session-entry-native-gesture-momentum-mirror-reset');
        expect(resolved.nativeStreamAppendRecordReset.type)
            .toBe('session-entry-native-stream-append-content-version-record-reset');
        expect(resolved.activityKeyBaselineReset.type).toBe('session-entry-activity-key-baseline-reset');
        expect(resolved.olderPaginationReset.type).toBe('session-entry-older-pagination-reset');
        expect(resolved.nativeSessionViewportReset.type).toBe('session-entry-native-session-viewport-reset');
        expect(resolved.entryRestoreActiveRefsReset.type)
            .toBe('session-entry-entry-restore-active-refs-reset');
        expect(resolved.entryRestoreLocalStateReset.type)
            .toBe('session-entry-entry-restore-local-state-reset');
        expect(resolved.entryRestoreTimeoutCleanup.type).toBe('session-entry-entry-restore-timeout-cleanup');
        expect(resolved.nativePrependInvalidation.type)
            .toBe('session-entry-native-prepend-transaction-invalidation');
        expect(resolved.nativeExplicitJumpReset.type)
            .toBe('session-entry-native-explicit-jump-confirmation-reset');
        expect(resolved.nativeEntrySettleReset).toMatchObject({
            shouldArmConfirmation: true,
            type: 'session-entry-native-entry-settle-confirmation-reset',
        });
        expect(resolved.nativeIndexScrollCommandCacheReset.type)
            .toBe('session-entry-native-index-scroll-command-cache-reset');
        expect(resolved.entryRestoreAnchorLookupReset.type)
            .toBe('session-entry-entry-restore-anchor-lookup-reset');
        expect(resolved.commandControllerReset).toMatchObject({
            openEntryTransaction: true,
            type: 'session-entry-command-controller-reset',
        });
        expect(resolved.measurementReset.type).toBe('session-entry-measurement-reset');
    });

    it('resolves web follow-bottom reset effects without native session viewport reset', () => {
        const resolved = resolveSessionEntryRenderResetEffects({
            effects: sessionEntryEffects({
                platform: 'web',
                shouldFollowLiveTail: true,
            }),
            platform: 'web',
            sessionId: 'session-a',
        });

        expect(resolved.platform).toBe('web');
        expect(resolved.nativeSessionViewportReset).toBeNull();
        expect(resolved.nativeEntrySettleReset.shouldArmConfirmation).toBe(false);
        expect(resolved.commandControllerReset.openEntryTransaction).toBe(false);
        expect(resolved.measurementReset.sessionId).toBe('session-a');
    });

    it('preserves restored native entry transaction and does not arm follow-bottom confirmation', () => {
        const resolved = resolveSessionEntryRenderResetEffects({
            effects: sessionEntryEffects({
                platform: 'native',
                shouldFollowLiveTail: false,
            }),
            platform: 'native',
            sessionId: 'session-a',
        });

        expect(resolved.commandControllerReset.openEntryTransaction).toBe(true);
        expect(resolved.nativeEntrySettleReset.shouldArmConfirmation).toBe(false);
    });

    it('ignores stale-session and unrelated effects when selecting current-session resets', () => {
        const currentEffects = sessionEntryEffects({
            platform: 'web',
            shouldFollowLiveTail: true,
        });
        const staleEffects = sessionEntryEffects({
            platform: 'native',
            sessionId: 'session-b',
            shouldFollowLiveTail: true,
        });

        const resolved = resolveSessionEntryRenderResetEffects({
            effects: [
                ...staleEffects,
                {
                    reason: 'jump-to-seq',
                    sessionId: 'session-a',
                    type: 'explicit-jump-preempt-entry-restore',
                },
                ...currentEffects,
            ],
            platform: 'web',
            sessionId: 'session-a',
        });

        expect(resolved.platform).toBe('web');
        expect(resolved.nativeSessionViewportReset).toBeNull();
        expect(resolved.commandControllerReset.openEntryTransaction).toBe(false);
    });

    it('fails fast when required current-session effects are missing', () => {
        const effects = sessionEntryEffects({
            platform: 'web',
            shouldFollowLiveTail: true,
        }).filter((effect) => effect.type !== 'session-entry-command-controller-reset');

        expect(() => resolveSessionEntryRenderResetEffects({
            effects,
            platform: 'web',
            sessionId: 'session-a',
        })).toThrow('Session-entry lifecycle did not emit command-controller reset effect');
    });

    it('fails fast when native session viewport reset is missing on native', () => {
        const effects = sessionEntryEffects({
            platform: 'native',
            shouldFollowLiveTail: true,
        }).filter((effect) => effect.type !== 'session-entry-native-session-viewport-reset');

        expect(() => resolveSessionEntryRenderResetEffects({
            effects,
            platform: 'native',
            sessionId: 'session-a',
        })).toThrow('Session-entry lifecycle did not emit native session viewport reset effect');
    });
});
