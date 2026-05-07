import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync JS thread lag telemetry lifecycle', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        kvStore.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        delete (globalThis as { nativeLoggingHook?: unknown }).nativeLoggingHook;
    });

    it('starts JS-lag sampling when sync performance telemetry is enabled', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON', JSON.stringify({
            syncPerformanceTelemetryEnabled: true,
            jsThreadLagTelemetrySampleIntervalMs: 50,
            jsThreadLagTelemetryThresholdMs: 10,
            jsThreadLagTelemetryMaxSamples: 8,
        }));

        const { sync } = await import('./sync');
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');

        await vi.advanceTimersByTimeAsync(50);
        sync.disconnectServer();

        const event = syncPerformanceTelemetry
            .snapshot()
            .events
            .find((candidate) => candidate.name === 'sync.runtime.jsThreadLag.summary');

        expect(event?.fields.count).toBeGreaterThan(0);
    });

    it('flushes JS-lag summaries while sync remains connected', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON', JSON.stringify({
            syncPerformanceTelemetryEnabled: true,
            syncPerformanceTelemetryFlushIntervalMs: 1000,
            jsThreadLagTelemetrySampleIntervalMs: 50,
            jsThreadLagTelemetryThresholdMs: 10,
            jsThreadLagTelemetryMaxSamples: 8,
        }));

        const nativeLoggingHook = vi.fn();
        (globalThis as { nativeLoggingHook?: typeof nativeLoggingHook }).nativeLoggingHook = nativeLoggingHook;

        await import('./sync');

        await vi.advanceTimersByTimeAsync(1050);

        const emitted = nativeLoggingHook.mock.calls
            .map((call) => String(call[0] ?? ''))
            .find((line) => line.includes('sync.runtime.jsThreadLag.summary'));

        expect(emitted).toContain('sync.runtime.jsThreadLag.summary');
    });

    it('does not start JS-lag sampling when sync performance telemetry is disabled', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON', JSON.stringify({
            syncPerformanceTelemetryEnabled: false,
            jsThreadLagTelemetrySampleIntervalMs: 50,
            jsThreadLagTelemetryThresholdMs: 10,
            jsThreadLagTelemetryMaxSamples: 8,
        }));

        const { sync } = await import('./sync');
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');

        await vi.advanceTimersByTimeAsync(50);
        sync.disconnectServer();

        expect(syncPerformanceTelemetry.snapshot().events).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'sync.runtime.jsThreadLag.summary' }),
            ]),
        );
    });
});
