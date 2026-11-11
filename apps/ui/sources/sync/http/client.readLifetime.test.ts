import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAbortController, NativeResponse } from '@/dev/testkit/fixtures/reactNativeFetchPrimitives';
import { createDeferred } from '@/dev/testkit';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { abortServerFetches, createServerFetchAtEndpoint, serverFetch } from './client';
import { InvalidateSync } from '@/utils/sessions/sync';
import { kvBulkGet } from '@/sync/api/account/apiKv';
import { decodeBoundedJsonResponse } from '@/sync/api/capabilities/decodeBoundedJsonResponse';
import { SERVER_PEER_LIVENESS_WINDOW_MS } from '@/sync/runtime/connectivity/serverReachabilityTuning';

// React Native installs this non-streaming Response implementation. Expo's
// transport supplies a separate streaming response, represented by Node below.
const StreamingResponse = Response;

const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.OS; } } });
});

afterEach(() => {
    abortServerFetches();
    resetRuntimeFetch();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    platform.OS = 'web';
});

describe('captured Home recovery read lifetime', () => {
    it.each(['folding', 'delivered'] as const)('retains a fully sent large Usage response while %s without mistaking consumer work for network inactivity', async phase => {
        vi.useFakeTimers();
        // QA-R123-REPLAY: 33,561,217 decoded bytes. The HTTP owner
        // transports opaque bytes; Usage opens and persists them in its consumer.
        const bytes = new Uint8Array(33_561_217).fill(32);
        const entered = createDeferred<void>();
        const folded = createDeferred<void>();
        let signal: AbortSignal | null | undefined;
        setRuntimeFetch(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/features') return Response.json({ ready: true });
            signal = init?.signal;
            return new StreamingResponse(new ReadableStream<Uint8Array>({
                start(controller) {
                    const rowBytes = Math.ceil(bytes.byteLength / 33);
                    for (let offset = 0; offset < bytes.byteLength; offset += rowBytes) {
                        controller.enqueue(bytes.subarray(offset, offset + rowBytes));
                    }
                    controller.close();
                },
            }), { headers: { 'content-type': 'application/x-ndjson' } });
        });
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://usage-fold.example.test', credentials: null });
        const pending = request('/v2/usage/session-evidence', { method: 'POST' }, { retry: 'none', recoveryRead: 'unbounded' }, async response => {
            const reader = response.body!.getReader();
            let received = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    received += chunk.value.byteLength;
                    if (phase === 'folding' && received === chunk.value.byteLength) {
                        entered.resolve();
                        await folded.promise;
                    }
                }
                if (phase === 'delivered') { entered.resolve(); await folded.promise; }
                return received;
            } finally { reader.releaseLock(); }
        }).then(value => ({ value }), (error: unknown) => ({ error }));
        try {
            await entered.promise;
            // A later independent read is not a replacement for this admitted POST.
            await expect(request('/v1/features', undefined, { retry: 'none' }, response => response.json()))
                .resolves.toEqual({ ready: true });
            await vi.advanceTimersByTimeAsync(SERVER_PEER_LIVENESS_WINDOW_MS + 1);
            expect(signal?.aborted, 'local folding is not a stalled network read').toBe(false);
            folded.resolve();
            await expect(pending).resolves.toEqual({ value: bytes.byteLength });
            expect(vi.getTimerCount()).toBe(0);
        } finally { folded.resolve(); await pending; }
    });

    it.each(['decoder', 'borrower'] as const)('preserves native response bytes for a %s when the global Response cannot accept streams', async consumer => {
        platform.OS = 'ios';
        vi.stubGlobal('Response', NativeResponse);
        const payload = { message: 'Hello 🌍 — café', enabled: true };
        const encoded = new TextEncoder().encode(JSON.stringify(payload));
        const entered = createDeferred<void>();
        let finish!: () => void;
        setRuntimeFetch(async () => new StreamingResponse(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoded.subarray(0, 10));
                finish = () => { controller.enqueue(encoded.subarray(10)); controller.close(); };
                if (consumer === 'decoder') finish();
                entered.resolve();
            },
        }), { headers: { 'content-type': 'application/json' } }));
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://native-response.example.test', credentials: null });
        if (consumer === 'decoder') {
            await expect(request('/v1/features', undefined, { retry: 'none' }, response => decodeBoundedJsonResponse(response, encoded.byteLength)))
                .resolves.toEqual(payload);
        } else {
            let settled = false;
            const pending = request('/v1/features', undefined, { retry: 'none' }).finally(() => { settled = true; });
            await entered.promise;
            await Promise.resolve();
            expect(settled).toBe(false);
            finish();
            const response = await pending;
            expect(response.bodyUsed).toBe(false);
            const clone = response.clone();
            await expect(response.json()).resolves.toEqual(payload);
            expect(response.bodyUsed).toBe(true);
            expect(() => response.clone()).toThrow(TypeError);
            await expect(decodeBoundedJsonResponse(clone, encoded.byteLength)).resolves.toEqual(payload);
        }
    });

    it('cancels an oversized native metadata body before waiting for the remaining bytes', async () => {
        platform.OS = 'ios';
        vi.stubGlobal('Response', NativeResponse);
        const cancelled = createDeferred<void>();
        const encoded = new TextEncoder().encode('{"value":"oversized"}');
        setRuntimeFetch(async () => new StreamingResponse(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(encoded); },
            cancel() { cancelled.resolve(); },
        })));
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://native-bounded.example.test', credentials: null });
        await expect(request('/v1/features', undefined, { retry: 'none' }, response => decodeBoundedJsonResponse(response, encoded.byteLength - 1)))
            .resolves.toBeNull();
        await cancelled.promise;
    });

    it('replaces a superseded InvalidateSync read immediately without backoff or consuming its failure budget', async () => {
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        let requests = 0;
        let release: (() => void) | undefined;
        setRuntimeFetch(async (_url, init) => {
            requests += 1;
            if (requests > 1) return Response.json({ ok: true });
            return await new Promise<Response>((_resolve, reject) => {
                release = () => reject(new DOMException('Aborted', 'AbortError'));
                init?.signal?.addEventListener('abort', release, { once: true });
                entered.resolve();
            });
        });
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://invalidation-retry.example.test', credentials: null });
        const retries = vi.fn();
        const sync = new InvalidateSync(async () => { await request('/read', undefined, { retry: 'none' }); }, {
            backoff: { minDelayMs: 1_000, maxDelayMs: 1_000, maxFailureCount: 1 }, onRetry: retries,
        });
        let settled = false;
        const pending = sync.invalidateAndAwait().then(() => { settled = true; }, error => { throw error; });
        void pending.catch(() => {});
        try {
            await entered.promise;
            abortServerFetches('manual-retry', { readOnly: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(requests).toBe(2);
            expect(settled).toBe(true);
            expect(retries).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            await pending;
        } finally { release?.(); sync.stop(); await pending.catch(() => {}); }
    });

    it.each(['headers', 'body'] as const)('replaces the real KV POST read during manual Retry at %s without a retry delay', async phase => {
        await upsertAndActivateServer({ serverUrl: `https://kv-${phase}.example.test` });
        platform.OS = 'android';
        vi.stubGlobal('AbortController', NativeAbortController);
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        const signals: Array<AbortSignal | null | undefined> = [];
        let release: (() => void) | undefined;
        setRuntimeFetch(async (url, init) => {
            if (new URL(String(url)).pathname !== '/v1/kv/bulk') return Response.json({ ok: true });
            signals.push(init?.signal);
            if (signals.length > 1) return Response.json({ values: [] });
            entered.resolve();
            if (phase === 'headers') return await new Promise<Response>((resolve, reject) => {
                release = () => resolve(Response.json({ values: [] }));
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                let closed = false;
                release = () => { if (!closed) { closed = true; controller.enqueue(new TextEncoder().encode('{"values":[]}')); controller.close(); } };
                init?.signal?.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')); } }, { once: true });
            } }));
        });
        let settled = false;
        const pending = kvBulkGet({ token: 'kv-synthetic-token' }, ['todo.retry'])
            .finally(() => { settled = true; });
        try {
            await entered.promise;
            abortServerFetches('manual-retry', { readOnly: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(signals.map(signal => signal?.aborted)).toEqual([true, false]);
            expect(settled).toBe(true);
            expect(await pending).toEqual({ values: [] });
            expect(vi.getTimerCount()).toBe(0);
        } finally { release?.(); await pending; }
    });

    it.each(['active', 'explicit'] as const)('retains cancellation through a returned %s response body', async kind => {
        const endpoint = `https://${kind}-body.example.test`;
        await upsertAndActivateServer({ serverUrl: endpoint });
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        vi.useFakeTimers();
        let heldSignal: AbortSignal | undefined | null;
        const entered = createDeferred<void>();
        const request = kind === 'active' ? serverFetch : createServerFetchAtEndpoint({ endpointUrl: endpoint, credentials: null });
        let release: (() => void) | undefined;
        setRuntimeFetch(async (_url, init) => {
            heldSignal = init?.signal;
            entered.resolve();
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                release = () => controller.error(new DOMException('Aborted', 'AbortError'));
                init?.signal?.addEventListener('abort', release, { once: true });
            } }));
        });
        let settled = false;
        const pending = request('/v2/changes', undefined, { includeAuth: false, retry: 'none', recoveryRead: 'paged' })
            .then(response => response.json()).then(() => null, (error: unknown) => error).finally(() => { settled = true; });
        try {
            await entered.promise;
            await vi.advanceTimersByTimeAsync(51);
            expect(settled).toBe(true);
            expect(heldSignal?.aborted).toBe(true);
            const error = await pending;
            expect(error).toMatchObject({ name: 'ServerFetchReadTimeoutError' });
            expect(isTransientConnectivityError(error)).toBe(true);
        } finally { release?.(); await pending; }
    });

    it.each(['paged', 'unbounded'] as const)('keeps native %s reads recoverable without imposing a deadline on large unpaged transfers', async recoveryRead => {
        platform.OS = 'android';
        vi.stubGlobal('AbortController', NativeAbortController);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        vi.useFakeTimers();
        const entered = createDeferred<void>();
        const transfer = createDeferred<Response>();
        setRuntimeFetch(async (_url, init) => {
            init?.signal?.addEventListener('abort', () => transfer.reject(new DOMException('Aborted', 'AbortError')), { once: true });
            entered.resolve();
            return transfer.promise;
        });
        let settled = false;
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://native-read.example.test', credentials: null });
        const pending = request('/read', undefined, { recoveryRead, retry: 'none' })
            .then(response => ({ response }), (error: unknown) => ({ error })).finally(() => { settled = true; });
        try {
            await entered.promise;
            await vi.advanceTimersByTimeAsync(51);
            expect(settled).toBe(recoveryRead === 'paged');
            transfer.resolve(Response.json({ ok: true }));
            expect(await pending).toMatchObject(recoveryRead === 'paged'
                ? { error: { name: 'ServerFetchReadTimeoutError' } } : { response: { ok: true } });
        } finally { transfer.resolve(Response.json({ ok: true })); await pending; }
    });

    it.each(['web', 'ios'])('allows a progressing %s body to exceed the inactivity window', async os => {
        platform.OS = os;
        if (os === 'ios') vi.stubGlobal('Response', NativeResponse);
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS', '50');
        vi.useFakeTimers();
        let body!: ReadableStreamDefaultController<Uint8Array>;
        setRuntimeFetch(async () => new StreamingResponse(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })));
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://progress.example.test', credentials: null });
        const pending = request('/read', undefined, { retry: 'none' }, response => response.json());
        await vi.advanceTimersByTimeAsync(0);
        for (const chunk of ['{"value":', '"slow', ' but progressing"}']) {
            await vi.advanceTimersByTimeAsync(40);
            body.enqueue(new TextEncoder().encode(chunk));
            await vi.advanceTimersByTimeAsync(0);
        }
        body.close();
        await expect(pending).resolves.toEqual({ value: 'slow but progressing' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])('handles late timer delivery with body progress=%s', async progressing => {
        vi.useFakeTimers();
        // Model background timer throttling at the clock boundary. Cancellation
        // still uses real timer handles; never invoke an already-cleared callback.
        const schedule = globalThis.setTimeout;
        const windowMs = SERVER_PEER_LIVENESS_WINDOW_MS;
        const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) =>
            schedule(handler, (delay ?? 0) + 2 * windowMs, ...args));
        let body!: ReadableStreamDefaultController<Uint8Array>;
        let signal: AbortSignal | null | undefined;
        setRuntimeFetch(async (_url, init) => {
            signal = init?.signal;
            return new StreamingResponse(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
        });
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://late-timer.example.test', credentials: null });
        const pending = request('/read', undefined, { retry: 'none' }, response => response.text())
            .then(value => ({ value }), (error: unknown) => ({ error }));
        try {
            await vi.advanceTimersByTimeAsync(0);
            if (progressing) {
                for (const chunk of ['a', 'b', 'c', 'd']) {
                    await vi.advanceTimersByTimeAsync(windowMs);
                    body.enqueue(new TextEncoder().encode(chunk));
                    await vi.advanceTimersByTimeAsync(0);
                    expect(signal?.aborted).toBe(false);
                }
                body.close();
                await expect(pending).resolves.toEqual({ value: 'abcd' });
            } else {
                await vi.advanceTimersByTimeAsync(3 * windowMs - 1);
                expect(signal?.aborted).toBe(false);
                await vi.advanceTimersByTimeAsync(1);
                await expect(pending).resolves.toEqual({ error: expect.objectContaining({ name: 'ServerFetchReadTimeoutError' }) });
                expect(signal?.aborted).toBe(true);
            }
            expect(vi.getTimerCount()).toBe(0);
        } finally { timer.mockRestore(); abortServerFetches(); await pending; }
    });

    it('manual recovery cancels GET and POST reads with native abort causes while preserving mutations', async () => {
        platform.OS = 'android';
        vi.stubGlobal('AbortController', NativeAbortController);
        const request = createServerFetchAtEndpoint({ endpointUrl: 'https://retry-read.example.test', credentials: null });
        const signals: AbortSignal[] = [];
        const releases: Array<() => void> = [];
        setRuntimeFetch(async (_url, init) => {
            signals.push(init!.signal!);
            return new Promise<Response>((resolve, reject) => {
                init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                releases.push(() => resolve(Response.json({ ok: true })));
            });
        });
        const reads = ['GET', 'POST'].map(method => request('/read', { method }, { retry: 'none', recoveryRead: 'unbounded' })
            .then(() => null, (error: unknown) => error));
        const write = request('/write', { method: 'POST' }, { retry: 'none' });
        try {
            await vi.waitFor(() => expect(releases).toHaveLength(3));
            abortServerFetches('manual-retry', { readOnly: true });
            expect(signals.map(signal => signal.aborted)).toEqual([true, true, false]);
            expect(await Promise.all(reads)).toEqual([
                expect.objectContaining({ name: 'ServerFetchReadSupersededError' }),
                expect.objectContaining({ name: 'ServerFetchReadSupersededError' }),
            ]);
        } finally { releases.forEach(release => release()); await Promise.all([...reads, write]); }
    });
});
