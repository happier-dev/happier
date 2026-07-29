import { describe, expect, it } from 'vitest';

import { createPluginReactNativeWatchdog } from './watchdog';

describe('React Native bundle watchdog', () => {
    function createMemoryPersistence(initialSnapshot: unknown = null) {
        let snapshot = initialSnapshot;
        return {
            readSnapshot: () => snapshot,
            writeSnapshot: (nextSnapshot: unknown) => {
                snapshot = nextSnapshot;
            },
        };
    }

    it('records startup acknowledgment timeouts and resets them after a successful ack', () => {
        let now = 1_000;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 2,
            nowMs: () => now,
        });

        watchdog.start({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        now = 1_600;
        expect(watchdog.collectExpired()).toEqual([{
            surfaceId: 'surface_1',
            cacheKey: 'cache_1',
            code: 'startup_ack_timeout',
            diagnostics: ['startup_ack_timeout', 'js_thread_hard_hang_not_contained'],
        }]);
        expect(watchdog.readState('surface_1')).toMatchObject({ startupFailureCount: 1, disabled: false });

        watchdog.start({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        watchdog.acknowledge({ surfaceId: 'surface_1' });
        expect(watchdog.readState('surface_1')).toMatchObject({ startupFailureCount: 0, disabled: false });
    });

    it('disables a surface after repeated render crashes', () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 2,
            nowMs: () => 1_000,
        });

        expect(watchdog.recordRenderError({ surfaceId: 'surface_1', cacheKey: 'cache_1' })).toMatchObject({
            disabled: false,
            crashCount: 1,
        });
        expect(watchdog.recordRenderError({ surfaceId: 'surface_1', cacheKey: 'cache_1' })).toMatchObject({
            disabled: true,
            crashCount: 2,
            diagnostics: ['crash_threshold_reached'],
        });
    });

    it('restores disabled state through the persistent watchdog store', () => {
        const persistence = createMemoryPersistence();
        const firstWatchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
            persistence,
        });

        firstWatchdog.recordRenderError({ surfaceId: 'surface_1', cacheKey: 'cache_1' });

        const secondWatchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 2_000,
            persistence,
        });

        expect(secondWatchdog.readState('surface_1')).toMatchObject({
            surfaceId: 'surface_1',
            cacheKey: 'cache_1',
            crashCount: 1,
            disabled: true,
        });
    });

    it('resets crash-disable state when the loadable artifact cache key changes', () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });

        watchdog.recordRenderError({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        expect(watchdog.readState('surface_1')).toMatchObject({ disabled: true });

        watchdog.start({ surfaceId: 'surface_1', cacheKey: 'cache_2' });

        expect(watchdog.readState('surface_1')).toMatchObject({
            cacheKey: 'cache_2',
            crashCount: 0,
            startupFailureCount: 0,
            disabled: false,
        });
    });

    it('cancels pending startup acknowledgment tracking without recording a timeout', () => {
        let now = 1_000;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => now,
        });

        watchdog.start({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        watchdog.cancel({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        now = 1_600;

        expect(watchdog.collectExpired()).toEqual([]);
        expect(watchdog.readState('surface_1')).toMatchObject({
            cacheKey: 'cache_1',
            crashCount: 0,
            startupFailureCount: 0,
            disabled: false,
        });
    });
});
