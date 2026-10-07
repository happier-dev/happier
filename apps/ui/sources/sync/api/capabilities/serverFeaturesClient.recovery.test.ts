import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerFeaturesSnapshot, probeServerFeaturesAtUrl, resetServerFeaturesClientForTests, type ProbeServerFeaturesAtUrlOptions } from './serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

afterEach(() => {
    resetServerFeaturesClientForTests();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
});

async function withHeldFirstResponse(run: (peer: {
    endpointUrl: string;
    firstReceived: Promise<void>;
    secondReceived: Promise<void>;
    releaseFirst: () => void;
    requestCount: () => number;
}) => Promise<void>) {
    let requests = 0;
    let first: ServerResponse | undefined;
    let acknowledgeFirst!: () => void;
    let acknowledgeSecond!: () => void;
    const firstReceived = new Promise<void>((resolve) => { acknowledgeFirst = resolve; });
    const secondReceived = new Promise<void>((resolve) => { acknowledgeSecond = resolve; });
    const server = createServer((request, response) => {
        if (request.url !== '/v1/features') {
            response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
            return;
        }
        requests += 1;
        if (requests === 1) {
            first = response;
            acknowledgeFirst();
        } else {
            response.writeHead(404).end();
            acknowledgeSecond();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    try {
        await run({
            endpointUrl: `http://127.0.0.1:${address.port}`,
            firstReceived,
            secondReceived,
            releaseFirst: () => first?.writeHead(405).end(),
            requestCount: () => requests,
        });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

describe('feature observation request lifetime over HTTP', () => {
    const createProbe = async (projection: 'endpoint' | 'focused', endpointUrl: string) => {
        if (projection === 'focused') {
            // The package harness owns the in-memory MMKV boundary; profile logic is real.
            await upsertAndActivateServer({ serverUrl: endpointUrl });
            return (options?: ProbeServerFeaturesAtUrlOptions) => getServerFeaturesSnapshot(options);
        }
        return (options?: ProbeServerFeaturesAtUrlOptions) => probeServerFeaturesAtUrl(endpointUrl, options);
    };

    it.each(['endpoint', 'focused'] as const)('supports native %s signals without throwIfAborted', async (projection) => {
        // Shape the real OS cancellation boundary like React Native's installed polyfill.
        const SystemAbortController = globalThis.AbortController;
        vi.stubGlobal('AbortController', class extends SystemAbortController {
            constructor() {
                super();
                Object.defineProperty(this.signal, 'throwIfAborted', { value: undefined });
            }
        });
        await withHeldFirstResponse(async (peer) => {
            const probe = await createProbe(projection, peer.endpointUrl);
            const observation = probe().then(value => ({ value }), (error: unknown) => ({ error }));
            await Promise.race([peer.firstReceived, new Promise<void>((resolve) => setTimeout(resolve, 150))]);
            peer.releaseFirst();
            expect(await observation).toEqual({ value: { status: 'unsupported', reason: 'endpoint_missing' } });
            expect(peer.requestCount()).toBe(1);
        });
    });

    it.each(['endpoint', 'focused'] as const)('admits a fresh %s retry after the sole observer abandons a stalled peer', async (projection) => {
        await withHeldFirstResponse(async (peer) => {
            const probe = await createProbe(projection, peer.endpointUrl);
            const firstCaller = new AbortController();
            const retryCaller = new AbortController();
            const first = probe({ signal: firstCaller.signal });
            await peer.firstReceived;
            firstCaller.abort();
            await expect(first).resolves.toEqual({ status: 'error', reason: 'network' });
            const retry = probe({ force: true, signal: retryCaller.signal });
            try {
                // Observation window for request admission, not a product deadline.
                await Promise.race([peer.secondReceived, new Promise<void>((resolve) => setTimeout(resolve, 150))]);
                expect(peer.requestCount()).toBe(2);
                await expect(retry).resolves.toEqual({ status: 'unsupported', reason: 'endpoint_missing' });
            } finally {
                retryCaller.abort();
                await retry;
            }
        });
    });

    it.each(['endpoint', 'focused'] as const)('keeps a shared slow %s HTTP request alive for the remaining observer', async (projection) => {
        await withHeldFirstResponse(async (peer) => {
            const probe = await createProbe(projection, peer.endpointUrl);
            const firstCaller = new AbortController();
            const remainingCaller = new AbortController();
            const first = probe({ signal: firstCaller.signal });
            await peer.firstReceived;
            const remaining = probe({ force: true, signal: remainingCaller.signal });
            firstCaller.abort();
            await first;
            try {
                peer.releaseFirst();
                await expect(remaining).resolves.toEqual({ status: 'unsupported', reason: 'endpoint_missing' });
                expect(peer.requestCount()).toBe(1);
            } finally {
                remainingCaller.abort();
                await remaining;
            }
        });
    });

    it.each(['endpoint', 'focused'] as const)('does not publish a retired %s transport completion over its replacement', async (projection) => {
        // Deliberately non-cancellable transport boundary; all HTTP/cache logic remains real.
        let acknowledgeRetiredResponse!: () => void;
        const retiredResponse = new Promise<void>((resolve) => { acknowledgeRetiredResponse = resolve; });
        setRuntimeFetch(async (input, init) => {
            const response = await fetch(input, { ...init, signal: undefined });
            if (response.status === 405) acknowledgeRetiredResponse();
            return response;
        });
        await withHeldFirstResponse(async (peer) => {
            const probe = await createProbe(projection, peer.endpointUrl);
            const oldCaller = new AbortController();
            const replacementCaller = new AbortController();
            const old = probe({ signal: oldCaller.signal });
            await peer.firstReceived;
            oldCaller.abort();
            await old;
            const replacement = probe({ force: true, signal: replacementCaller.signal });
            try {
                await Promise.race([peer.secondReceived, new Promise<void>((resolve) => setTimeout(resolve, 150))]);
                expect(peer.requestCount()).toBe(2);
                const readyReplacement = await replacement;
                peer.releaseFirst();
                await retiredResponse;
                // Drain the response continuation after observing the actual HTTP completion.
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                const cached = await probe();
                expect(cached).toBe(readyReplacement);
                expect(peer.requestCount()).toBe(2);
            } finally {
                replacementCaller.abort();
                await replacement;
            }
        });
    });
});
