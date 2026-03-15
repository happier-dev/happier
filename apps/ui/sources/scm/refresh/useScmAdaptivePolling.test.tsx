import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    AppState: {
        addEventListener: () => ({ remove: () => {} }),
    },
    Platform: { OS: 'web' },
}));

describe('useScmAdaptivePolling', () => {
    it('does not poll when baseIntervalMs is 0 (prevents tight loops)', async () => {
        vi.useFakeTimers();

        const { useScmAdaptivePolling } = await import('./useScmAdaptivePolling');

        const invalidateAndAwait = vi.fn(async () => {});
        const getSignature = vi.fn(() => 'sig1');

        function Test() {
            useScmAdaptivePolling({
                enabled: true,
                baseIntervalMs: 0,
                stepIntervalMs: 0,
                maxIntervalMs: 60_000,
                getSignature,
                invalidateAndAwait,
            });
            return null;
        }

        await act(async () => {
            renderer.create(<Test />);
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(0);

        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(0);
        vi.useRealTimers();
    });

    it('backs off when signature does not change and resets when it does', async () => {
        vi.useFakeTimers();

        const { useScmAdaptivePolling } = await import('./useScmAdaptivePolling');

        let signature = 'sig1';
        const invalidateAndAwait = vi.fn(async () => {});
        const getSignature = vi.fn(() => signature);

        function Test() {
            useScmAdaptivePolling({
                enabled: true,
                baseIntervalMs: 1000,
                stepIntervalMs: 1000,
                maxIntervalMs: 4000,
                getSignature,
                invalidateAndAwait,
            });
            return null;
        }

        await act(async () => {
            renderer.create(<Test />);
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(1000);
        });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(2);

        // unchanged -> backoff to 2000
        await act(async () => {
            vi.advanceTimersByTime(1999);
        });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(2);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(3);

        // now change signature -> interval resets to base
        signature = 'sig2';
        await act(async () => {
            vi.advanceTimersByTime(2999);
        });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(3);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(4);

        await act(async () => {
            vi.advanceTimersByTime(999);
        });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(4);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(invalidateAndAwait).toHaveBeenCalledTimes(5);

        vi.useRealTimers();
    });

    it('continues polling after invalidateAndAwait throws', async () => {
        vi.useFakeTimers();

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

        function Test() {
            useScmAdaptivePolling({
                enabled: true,
                baseIntervalMs: 1000,
                stepIntervalMs: 1000,
                maxIntervalMs: 4000,
                getSignature,
                invalidateAndAwait,
            });
            return null;
        }

        await act(async () => {
            renderer.create(<Test />);
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(1000);
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(2);

        signature = 'sig2';
        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        expect(invalidateAndAwait).toHaveBeenCalledTimes(3);

        vi.useRealTimers();
    });
});
