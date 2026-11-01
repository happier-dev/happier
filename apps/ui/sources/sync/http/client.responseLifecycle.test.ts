import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { peekServerReachabilityState, resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { stopAllEndpointSupervisorsForTests } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import { abortServerFetches, serverFetch } from './client';

afterEach(async () => {
    abortServerFetches();
    await resetServerReachabilitySupervisors();
    await stopAllEndpointSupervisorsForTests();
    resetRuntimeFetch();
    vi.useRealTimers();
});

describe('serverFetch response consumption lifecycle', () => {
    it.each(['caller', 'server-switch', 'timeout'] as const)('keeps %s cancellation connected while consuming a response body', async (cause) => {
        const profile = upsertServerProfile({ serverUrl: 'https://response-lifecycle.example' });
        setActiveServerId(profile.id);
        const headersReceived = createDeferred<void>();
        const controller = new AbortController();
        let bodyStarted = false;
        const network: { signal?: AbortSignal | null } = {};
        // HTTP is the boundary: headers arrive, but the native response body stays open until abort.
        setRuntimeFetch(async (_input, init) => {
            network.signal = init?.signal ?? null;
            const stream = new ReadableStream<Uint8Array>({
                start(streamController) {
                    init?.signal?.addEventListener('abort', () => {
                        streamController.error(new DOMException('Aborted', 'AbortError'));
                    }, { once: true });
                },
            });
            headersReceived.resolve();
            return new Response(stream, { headers: { 'content-type': 'application/json' } });
        });
        vi.useFakeTimers();
        const pending = serverFetch('/v2/sessions/session/archive', {
            method: 'POST', signal: controller.signal,
        }, {
            includeAuth: false, retry: 'none', ...(cause === 'timeout' ? { timeoutMs: 50 } : {}),
        }, async (response) => {
            bodyStarted = true;
            return await response.json();
        });
        const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
        try {
            await headersReceived.promise;
            await vi.advanceTimersByTimeAsync(0);
            expect(bodyStarted).toBe(true);
            if (cause === 'caller') controller.abort();
            else if (cause === 'server-switch') abortServerFetches();
            else await vi.advanceTimersByTimeAsync(50);
            const result = await outcome;
            expect(result).toMatchObject({ error: { name: cause === 'server-switch'
                ? 'ServerFetchAbortedForServerSwitchError'
                : cause === 'timeout' ? 'ServerFetchWriteTimeoutError' : 'AbortError' } });
            expect(network.signal?.aborted).toBe(true);
        } finally {
            controller.abort();
            await outcome;
        }
    });

    it('does not replay a write or mark its server unreachable when response parsing fails', async () => {
        const profile = upsertServerProfile({ serverUrl: 'https://response-parse-failure.example' });
        setActiveServerId(profile.id);
        let writes = 0;
        setRuntimeFetch(async (_input, init) => {
            if (init?.method === 'POST') {
                writes += 1;
                return new Response('{', { headers: { 'content-type': 'application/json' } });
            }
            return new Response('ok');
        });
        await expect(serverFetch('/v2/sessions/session/archive', { method: 'POST' }, { includeAuth: false },
            async (response) => await response.json())).rejects.toMatchObject({ name: 'SyntaxError' });
        expect(writes).toBe(1);
        expect(peekServerReachabilityState(profile.serverUrl)?.phase).toBe('online');
    });
});
