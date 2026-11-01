import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
// Exercise the exact environment boundary installed by React Native's Libraries/Core/setUpXHR.js.
import { AbortController as NativeAbortController } from 'abort-controller';

import { createDeferred } from '@/dev/testkit';
import { kvBulkGet } from '@/sync/api/account/apiKv';
import { fetchSessionMessagesPage } from '@/sync/api/session/sessionMessagesApi';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { stopAllEndpointSupervisorsForTests } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import { createTranscriptLoadingDomain, type TranscriptLoadingDomain } from '@/sync/store/domains/transcriptLoading';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { InvalidateSync } from '@/utils/sessions/sync';
import { createBackoff } from '@/utils/timing/time';
import { abortServerFetches, serverFetch } from './client';

const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.OS; } } });
});

afterEach(async () => {
    abortServerFetches();
    await resetServerReachabilitySupervisors();
    await stopAllEndpointSupervisorsForTests();
    resetRuntimeFetch();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    platform.OS = 'web';
});

describe('recovery read lifetime', () => {
    it.each(['headers', 'body'] as const)('immediately replaces a superseded KV bulk POST held at %s', async (phase) => {
        setActiveServerId(upsertServerProfile({ serverUrl: `https://kv-retry-${phase}.example` }).id);
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        const heldHeaders = createDeferred<Response>();
        let heldBody: ReadableStreamDefaultController<Uint8Array> | undefined;
        let signal: AbortSignal | null | undefined;
        let requests = 0;
        setRuntimeFetch(async (input, init) => {
            if (new URL(String(input)).pathname !== '/v1/kv/bulk') return Response.json({ ok: true });
            requests += 1;
            if (requests > 1) return Response.json({ values: [] });
            signal = init?.signal;
            entered.resolve();
            if (phase === 'headers') return await heldHeaders.promise;
            return new Response(new ReadableStream<Uint8Array>({ start(controller) { heldBody = controller; } }));
        });
        const pending = kvBulkGet({ token: 'test', secret: 'unused' }, ['todo.retry']);
        try {
            await entered.promise;
            await vi.advanceTimersByTimeAsync(0);
            abortServerFetches('manual-retry', { readOnly: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(signal?.aborted).toBe(true);
            expect(requests).toBe(2);
            await expect(pending).resolves.toEqual({ values: [] });
        } finally {
            heldHeaders.resolve(Response.json({ values: [] }));
            if (heldBody) {
                try { heldBody.enqueue(new TextEncoder().encode('{"values":[]}')); heldBody.close(); } catch { /* cancelled stream */ }
            }
            await vi.advanceTimersByTimeAsync(1000);
            await pending;
        }
    });

    it.each(['invalidate', 'api'] as const)('does not charge Retry supersession to the %s failure budget or backoff', async (owner) => {
        setActiveServerId(upsertServerProfile({ serverUrl: `https://retry-budget-${owner}.example` }).id);
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        const held = createDeferred<Response>();
        const retries = vi.fn();
        let requests = 0;
        setRuntimeFetch(async () => {
            requests += 1;
            if (requests > 1) return Response.json({ ok: true });
            entered.resolve();
            return await held.promise;
        });
        const command = async () => {
            await serverFetch('/v1/kv', undefined, { includeAuth: false, retry: 'none' });
        };
        const sync = new InvalidateSync(command, {
            backoff: { minDelayMs: 1000, maxDelayMs: 1000, maxFailureCount: 1 }, onRetry: retries,
        });
        const run = owner === 'invalidate' ? sync.invalidateAndAwait()
            : createBackoff({ minDelay: 1000, maxDelay: 1000, maxFailureCount: 1, onRetry: retries })(command);
        let settled = false;
        const outcome = run.then(() => ({ ok: true }), (error: unknown) => ({ error }))
            .finally(() => { settled = true; });
        try {
            await entered.promise;
            abortServerFetches('manual-retry', { readOnly: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(true);
            expect(await outcome).toEqual({ ok: true });
            expect(requests).toBe(2);
            expect(retries).not.toHaveBeenCalled();
        } finally {
            held.resolve(Response.json({ ok: true }));
            await vi.advanceTimersByTimeAsync(1000);
            await outcome;
            sync.stop();
        }
    });

    it.each(['timeout', 'manual'] as const)('preserves %s classification with the actual native AbortController polyfill', async (cause) => {
        platform.OS = 'android';
        vi.stubGlobal('AbortController', NativeAbortController);
        setActiveServerId(upsertServerProfile({ serverUrl: `https://native-abort-${cause}.example` }).id);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        let release: (() => void) | undefined;
        setRuntimeFetch(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
            release = () => reject(new Error('boundary cleanup'));
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
            entered.resolve();
        }));
        const pending = serverFetch('/native-read', undefined, {
            includeAuth: false, retry: 'none', recoveryRead: cause === 'timeout' ? 'paged' : 'unbounded',
        }).then(() => null, (error: unknown) => error);
        try {
            await entered.promise;
            if (cause === 'manual') abortServerFetches('manual-retry', { readOnly: true });
            else await vi.advanceTimersByTimeAsync(51);
            expect(await pending).toMatchObject({ name: cause === 'manual' ? 'ServerFetchReadSupersededError' : 'ServerFetchReadTimeoutError' });
        } finally {
            release?.();
            await pending;
        }
    });
    it.each(['paged', 'unbounded'] as const)('native %s reads distinguish server-bounded pages from large unpaged transfers', async (policy) => {
        platform.OS = 'android';
        setActiveServerId(upsertServerProfile({ serverUrl: `https://native-${policy}.example` }).id);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        const transfer = createDeferred<Response>();
        setRuntimeFetch(async (_input, init) => {
            init?.signal?.addEventListener('abort', () => transfer.reject(new DOMException('Aborted', 'AbortError')), { once: true });
            entered.resolve();
            return await transfer.promise;
        });
        let settled = false;
        const pending = serverFetch('/native-read', undefined, { includeAuth: false, retry: 'none', recoveryRead: policy })
            .then(response => ({ response }), (error: unknown) => ({ error })).finally(() => { settled = true; });
        try {
            await entered.promise;
            await vi.advanceTimersByTimeAsync(51);
            expect(settled).toBe(policy === 'paged');
            transfer.resolve(Response.json({ sessions: [] }));
            expect(await pending).toMatchObject(policy === 'paged'
                ? { error: { name: 'ServerFetchReadTimeoutError' } }
                : { response: { ok: true } });
        } finally {
            transfer.resolve(Response.json({ sessions: [] }));
            await pending;
        }
    });
    it.each(['headers', 'body'] as const)('releases catch-up and permits a fresh read after stalled %s', async (phase) => {
        setActiveServerId(upsertServerProfile({ serverUrl: `https://read-${phase}.example` }).id);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        let release: (() => void) | undefined;
        let requests = 0;
        let heldSignal: AbortSignal | null | undefined;
        setRuntimeFetch(async (_input, init) => {
            requests += 1;
            if (requests > 1) return Response.json({ messages: [], hasMore: false });
            heldSignal = init?.signal;
            entered.resolve();
            if (phase === 'headers') return await new Promise<Response>((_resolve, reject) => {
                release = () => reject(new DOMException('Aborted', 'AbortError'));
                init?.signal?.addEventListener('abort', release, { once: true });
            });
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                release = () => controller.error(new DOMException('Aborted', 'AbortError'));
                init?.signal?.addEventListener('abort', release, { once: true });
            } }));
        });
        const store = createStore<TranscriptLoadingDomain>((set, get) => createTranscriptLoadingDomain({ set, get }));
        const request = (path: string) => serverFetch(path, { method: 'GET' }, {
            includeAuth: false, retry: 'none', recoveryRead: 'paged',
        });
        store.getState().beginSessionCatchUpNewer('s1');
        let settled = false;
        const pending = fetchSessionMessagesPage({ path: '/v1/sessions/s1/messages', request })
            .then(() => null, (error: unknown) => error).finally(() => {
                settled = true;
                store.getState().endSessionCatchUpNewer('s1');
            });
        try {
            await entered.promise;
            await vi.advanceTimersByTimeAsync(51);
            expect(settled).toBe(true);
            expect(heldSignal?.aborted).toBe(true);
            expect(store.getState().sessionCatchUpNewerInFlight.s1 ?? 0).toBe(0);
            const error = await pending;
            expect(error).toMatchObject({ name: 'ServerFetchReadTimeoutError' });
            expect(isTransientConnectivityError(error)).toBe(true);
            await expect(request('/v1/sessions/s1/messages')).resolves.toMatchObject({ ok: true });
            expect(requests).toBe(2);
        } finally {
            release?.();
            await pending;
        }
    });

    it('keeps a progressing body alive beyond the inactivity window', async () => {
        setActiveServerId(upsertServerProfile({ serverUrl: 'https://read-progress.example' }).id);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        vi.useFakeTimers();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        setRuntimeFetch(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
        let settled = false;
        const pending = serverFetch('/v2/changes', undefined, { includeAuth: false, retry: 'none', recoveryRead: 'paged' },
            response => response.json()).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        for (const chunk of ['{"value":', '"slow', ' but progressing"}']) {
            await vi.advanceTimersByTimeAsync(40);
            stream.enqueue(new TextEncoder().encode(chunk));
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(false);
        }
        stream.close();
        await expect(pending).resolves.toEqual({ value: 'slow but progressing' });
    });

    it('manual recovery aborts held reads, including POST reads, while preserving writes', async () => {
        setActiveServerId(upsertServerProfile({ serverUrl: 'https://read-retry.example' }).id);
        const signals: AbortSignal[] = [];
        setRuntimeFetch(async (_input, init) => {
            signals.push(init!.signal!);
            return await new Promise<Response>((resolve, reject) => {
                init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                releases.push(() => resolve(Response.json({ ok: true })));
            });
        });
        const releases: Array<() => void> = [];
        const reads = ['GET', 'POST'].map(method => serverFetch('/read', { method }, {
            includeAuth: false, retry: 'none', recoveryRead: 'unbounded',
        }).then(() => null, (error: unknown) => error));
        const write = serverFetch('/write', { method: 'POST' }, { includeAuth: false, retry: 'none' });
        await vi.waitFor(() => expect(releases).toHaveLength(3));
        abortServerFetches('manual-retry', { readOnly: true });
        try {
            expect(signals.map(signal => signal.aborted)).toEqual([true, true, false]);
            expect(await Promise.all(reads)).toEqual([
                expect.objectContaining({ name: 'ServerFetchReadSupersededError' }),
                expect.objectContaining({ name: 'ServerFetchReadSupersededError' }),
            ]);
        } finally {
            releases.forEach(release => release());
            await write;
        }
    });
});
