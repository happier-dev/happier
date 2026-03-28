import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    AppState: {
                        addEventListener: () => ({ remove: () => {} }),
                    },
                    Platform: {
                        OS: 'web',
                    },
                }
    );
});

describe('useScmAdaptivePolling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not poll when baseIntervalMs is 0 (prevents tight loops)', async () => {
        const { useScmAdaptivePolling } = await import('./useScmAdaptivePolling');

        const invalidateAndAwait = vi.fn(async () => {});
        const getSignature = vi.fn(() => 'sig1');

        await renderHook(() => {
            useScmAdaptivePolling({
                enabled: true,
                baseIntervalMs: 0,
                stepIntervalMs: 0,
                maxIntervalMs: 60_000,
                getSignature,
                invalidateAndAwait,
            });
            return null;
        }, {
            flushOptions: { cycles: 0 },
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(0);

        await flushHookEffects({ cycles: 1, advanceTimersMs: 10_000 });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(0);
    });

    it('backs off when signature does not change and resets when it does', async () => {
        const { useScmAdaptivePolling } = await import('./useScmAdaptivePolling');

        let signature = 'sig1';
        const invalidateAndAwait = vi.fn(async () => {});
        const getSignature = vi.fn(() => signature);

        await renderHook(() => {
            useScmAdaptivePolling({
                enabled: true,
                baseIntervalMs: 1000,
                stepIntervalMs: 1000,
                maxIntervalMs: 4000,
                getSignature,
                invalidateAndAwait,
            });
            return null;
        }, {
            flushOptions: { cycles: 0 },
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(1);

        await flushHookEffects({ cycles: 1, advanceTimersMs: 1000 });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(2);

        // unchanged -> backoff to 2000
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1999 });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(2);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(3);

        // now change signature -> interval resets to base
        signature = 'sig2';
        await flushHookEffects({ cycles: 1, advanceTimersMs: 2999 });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(3);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(4);

        await flushHookEffects({ cycles: 1, advanceTimersMs: 999 });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(4);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(5);
    });

    it('continues polling after invalidateAndAwait throws', async () => {
        const { useScmAdaptivePolling } = await import('./useScmAdaptivePolling');

        let signature = 'sig1';
        let calls = 0;
        const invalidateAndAwait = vi.fn(async () => {
            calls++;
            if (calls === 1) {
                throw new Error('boom');
            }
        });
        const getSignature = vi.fn(() => signature);

        await renderHook(() => {
            useScmAdaptivePolling({
                enabled: true,
                baseIntervalMs: 1000,
                stepIntervalMs: 1000,
                maxIntervalMs: 4000,
                getSignature,
                invalidateAndAwait,
            });
            return null;
        }, {
            flushOptions: { cycles: 0 },
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(1);

        await flushHookEffects({ cycles: 1, advanceTimersMs: 1000 });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(2);

        signature = 'sig2';
        await flushHookEffects({ cycles: 1, advanceTimersMs: 2000 });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(3);
    });
});
