import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    peekServerReachabilityState,
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    subscribeServerReachabilityState,
    waitForServerReachable,
} from './serverReachabilitySupervisorPool';

function carrierForEndpoint(endpointId: string): HomeCarrier {
    // A fresh object each call: a re-leased carrier is a new object for the same endpoint.
    return {
        endpointId,
        readObservedPath: () => 'relay',
        request: async () => new Response(null, { status: 200, headers: new Headers() }),
        createWebSocket: () => ({}),
    };
}

describe('serverReachabilitySupervisorPool (transport identity)', () => {
    beforeEach(() => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(async () => {
        resetRuntimeFetch();
        await resetServerReachabilitySupervisors();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([
        {
            name: 'a runtime origin equal to the server URL',
            // The socket owner starts without a distinct runtime origin; a plain request path then spells the same transport out.
            initial: {},
            next: { runtimeOrigin: 'https://example.test' },
            sameTransport: true,
        },
        {
            name: 'a runtime origin naming a different transport',
            initial: {},
            next: { runtimeOrigin: 'https://tunnel.example.test' },
            sameTransport: false,
        },
        {
            name: 'a re-leased carrier for the same endpoint',
            // A fresh object each call: the carrier owner re-leased it, the transport did not change.
            initial: { homeCarrier: carrierForEndpoint('endpoint-a') },
            next: { homeCarrier: carrierForEndpoint('endpoint-a') },
            sameTransport: true,
        },
        {
            name: 'a carrier proving a different endpoint',
            initial: { homeCarrier: carrierForEndpoint('endpoint-a') },
            next: { homeCarrier: carrierForEndpoint('endpoint-b') },
            sameTransport: false,
        },
    ])('$name: same transport=$sameTransport', async ({ initial, next }) => {
        setRuntimeFetch(async () => new Response(null, { status: 200, headers: new Headers() }));
        const serverUrl = 'https://example.test';
        const phases: string[] = [];
        const unsubscribe = subscribeServerReachabilityState(serverUrl, (state) => {
            phases.push(state.phase);
        }, null);

        try {
            await startServerReachabilitySupervisor({ serverUrl, token: null, ...initial });
            expect(peekServerReachabilityState(serverUrl, null)?.phase).toBe('online');

            phases.length = 0;

            await startServerReachabilitySupervisor({ serverUrl, token: null, ...next });

            // A healthy readiness re-probe is not an outage, even when another
            // caller selects a different byte transport for this same Home.
            expect(phases).not.toContain('shutting_down');
            expect(phases).not.toContain('connecting');
            expect(peekServerReachabilityState(serverUrl, null)?.phase).toBe('online');
        } finally {
            unsubscribe();
        }
    });

    it('keeps the selected carrier when a readiness observer omits transport hints', async () => {
        setRuntimeFetch(async () => { throw new TypeError('Canonical URL has no ingress'); });
        const serverUrl = 'https://example.test';
        const phases: string[] = [];
        const unsubscribe = subscribeServerReachabilityState(serverUrl, state => { phases.push(state.phase); }, null);
        try {
            await startServerReachabilitySupervisor({ serverUrl, token: null, homeCarrier: carrierForEndpoint('endpoint-a') });
            phases.length = 0;
            await startServerReachabilitySupervisor({ serverUrl, token: null });
            expect(peekServerReachabilityState(serverUrl, null)?.phase).toBe('online');
            expect(phases).not.toContain('shutting_down');
            await startServerReachabilitySupervisor({ serverUrl, token: null, runtimeOrigin: serverUrl, homeCarrier: null });
            expect(peekServerReachabilityState(serverUrl, null)?.phase).toBe('offline');
        } finally {
            unsubscribe();
        }
    });

    it('keeps the selected native origin for an observer and re-probes an explicit direct admission', async () => {
        const serverUrl = 'https://example.test';
        const runtimeOrigin = 'http://127.0.0.1:43210';
        const requests: string[] = [];
        setRuntimeFetch(async (url) => {
            requests.push(String(url));
            return new Response(null, { status: 200 });
        });
        await startServerReachabilitySupervisor({ serverUrl, token: null, runtimeOrigin });
        await waitForServerReachable({ serverUrl, token: null });
        expect(requests).toEqual([`${runtimeOrigin}/health`]);
        await waitForServerReachable({ serverUrl, token: null, runtimeOrigin: serverUrl, homeCarrier: null });
        expect(requests).toEqual([`${runtimeOrigin}/health`, `${serverUrl}/health`]);
        expect(peekServerReachabilityState(serverUrl, null)?.phase).toBe('online');
    });

    it('does not admit a failing direct reset with the previous native transport verdict', async () => {
        const serverUrl = 'https://example.test';
        const runtimeOrigin = 'http://127.0.0.1:43210';
        const controller = new AbortController();
        setRuntimeFetch(async (url) => {
            if (new URL(String(url)).origin === serverUrl) throw new TypeError('Direct ingress unavailable');
            return new Response(null, { status: 200 });
        });
        await startServerReachabilitySupervisor({ serverUrl, token: null, runtimeOrigin });
        const phases: string[] = [];
        const unsubscribe = subscribeServerReachabilityState(serverUrl, state => {
            phases.push(state.phase);
            if (state.phase === 'offline') controller.abort();
        }, null);
        try {
            await expect(waitForServerReachable({ serverUrl, token: null, runtimeOrigin: serverUrl, homeCarrier: null, signal: controller.signal }))
                .rejects.toMatchObject({ name: 'AbortError' });
            expect(phases).toContain('offline');
        } finally {
            unsubscribe();
        }
    });
});
