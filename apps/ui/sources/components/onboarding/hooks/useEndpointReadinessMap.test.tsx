import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { Text } from '@/components/ui/text/Text';

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => runtimeFetchMock(input, init),
}));

describe('useEndpointReadinessMap', () => {
    beforeEach(() => {
        runtimeFetchMock.mockReset();
        vi.resetModules();
        vi.useFakeTimers();
        vi.doMock('react-native', installReactNativeWebMock({
            Platform: { OS: 'web' },
            AppState: { currentState: 'active' },
        }));
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('does not abort readiness probes while state updates are flowing', async () => {
        runtimeFetchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const { useEndpointReadinessMap } = await import('./useEndpointReadinessMap');

        const endpoint = 'https://relay.example.test';
        function Harness() {
            const { readinessByEndpoint } = useEndpointReadinessMap({
                endpoints: [endpoint],
                enabled: true,
                timeoutMs: 250,
            });
            const status = readinessByEndpoint.get(endpoint)?.status ?? 'unknown';
            return <Text testID="probe-status">{status}</Text>;
        }

        const screen = await renderScreen(<Harness />);

        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(screen.findByTestId('probe-status')?.props.children).toBe('checking');

        await act(async () => {
            vi.advanceTimersByTime(30);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('probe-status')?.props.children).toBe('ready');
    });

    it('does not mark endpoints unavailable when readiness probes return retry_later', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const previousDocument = globalWithDocument.document;
        try {
            globalWithDocument.document = { visibilityState: 'hidden' };

            const { useEndpointReadinessMap } = await import('./useEndpointReadinessMap');

            const endpoint = 'https://relay.example.test';
            function Harness() {
                const { readinessByEndpoint } = useEndpointReadinessMap({
                    endpoints: [endpoint],
                    enabled: true,
                    timeoutMs: 250,
                });
                const status = readinessByEndpoint.get(endpoint)?.status ?? 'unknown';
                return <Text testID="probe-status">{status}</Text>;
            }

            const screen = await renderScreen(<Harness />);
            await flushHookEffects({ cycles: 3, turns: 3 });

            expect(runtimeFetchMock).not.toHaveBeenCalled();
            expect(screen.findByTestId('probe-status')?.props.children).toBe('unknown');
        } finally {
            globalWithDocument.document = previousDocument;
        }
    });

    it('marks endpoints blocked when the browser rejects mixed-content HTTP probes from an HTTPS page', async () => {
        const globalWithLocation = globalThis as unknown as { location?: unknown };
        const previousLocation = globalWithLocation.location;
        try {
            globalWithLocation.location = { protocol: 'https:' };

            const { useEndpointReadinessMap } = await import('./useEndpointReadinessMap');

            const endpoint = 'http://127.0.0.1:53288';
            function Harness() {
                const { readinessByEndpoint } = useEndpointReadinessMap({
                    endpoints: [endpoint],
                    enabled: true,
                    timeoutMs: 250,
                });
                const status = readinessByEndpoint.get(endpoint)?.status ?? 'unknown';
                return <Text testID="probe-status">{status}</Text>;
            }

            const screen = await renderScreen(<Harness />);
            await flushHookEffects({ cycles: 3, turns: 3 });

            expect(runtimeFetchMock).not.toHaveBeenCalled();
            expect(screen.findByTestId('probe-status')?.props.children).toBe('blocked');
        } finally {
            globalWithLocation.location = previousLocation;
        }
    });

    it('ignores stale probe results when a newer retry supersedes them', async () => {
        runtimeFetchMock
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 50));
                throw new Error('network down');
            })
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 5));
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
            });

        const { useEndpointReadinessMap } = await import('./useEndpointReadinessMap');

        const endpoint = 'https://relay.example.test';
        let retry: ((endpoint: string) => void) | null = null;
        function Harness() {
            const { readinessByEndpoint, retryEndpoint } = useEndpointReadinessMap({
                endpoints: [endpoint],
                enabled: true,
                timeoutMs: 250,
            });
            retry = retryEndpoint;
            const status = readinessByEndpoint.get(endpoint)?.status ?? 'unknown';
            return <Text testID="probe-status">{status}</Text>;
        }

        const screen = await renderScreen(<Harness />);
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(screen.findByTestId('probe-status')?.props.children).toBe('checking');

        await act(async () => {
            retry?.(endpoint);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await act(async () => {
            vi.advanceTimersByTime(10);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.findByTestId('probe-status')?.props.children).toBe('ready');

        await act(async () => {
            vi.advanceTimersByTime(60);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.findByTestId('probe-status')?.props.children).toBe('ready');
    });
});
