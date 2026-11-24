import { Platform } from 'react-native';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileDownloadHarness } from './workspaceFileDownloadHarness';
import { downloadDaemonWorkspaceFileToDestination, uploadDaemonWorkspaceFileFromReader } from '@/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers';
import { createBufferedTransferDestination } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/createBufferedTransferDestination';
import { downloadBulkJsonPayloadViaDirectExport } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferExportDownload';
import { resolveMachineCarrierRoute } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease';
import { createSessionFilePreviewSource } from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';

function createDesktopHarness(options: Parameters<typeof createWorkspaceFileDownloadHarness>[0] = {}) {
    return createWorkspaceFileDownloadHarness({ ...options, host: 'desktop' });
}

describe('workspace download genuine boundary harness', () => {
    const previousPlatform = Platform.OS;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;
    beforeEach(async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        harness = await createDesktopHarness();
    });
    afterEach(async () => {
        await harness?.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
        vi.unstubAllGlobals();
    });
    async function prepareJsonDownload(options: Parameters<typeof createWorkspaceFileDownloadHarness>[0] = {}, timeoutMs?: number,
        parsePayload: (value: unknown) => unknown = value => value) {
        await harness.reset();
        harness = await createDesktopHarness({ ...options, composerInspection: { id: 'json-vector-stage' } });
        const handle = harness.composerHandle;
        if (!handle) throw new Error('Composer fixture did not prepare its owned stage');
        const route = await resolveMachineCarrierRoute(harness.scope.machineId, harness.scope.serverId);
        if (route.kind === 'unavailable') throw new Error('Composer fixture Machine carrier was unavailable');
        return () => downloadBulkJsonPayloadViaDirectExport({ machineId: harness.scope.machineId, serverId: harness.scope.serverId,
            request: { t: 'composer_media_stage_inspect_v1', handle, offset: 0, maxBytes: handle.sizeBytes },
            parsePayload, timeoutMs, acquirePreparedCarrier: prepared => route.acquire(prepared) });
    }
    it('downloads a mapped workspace file preview and closes its one native tunnel', async () => {
        const result = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null, retainBytes: true,
        });
        expect(result).toMatchObject({ ok: true, source: { kind: 'object-url', byteLength: 3, bytes: new Uint8Array([1, 2, 3]) } });
        if (result.ok && result.source.kind === 'object-url') result.source.revoke();
        // A mapped file target that skips the transfer lifecycle can still deliver correct bytes.
        expect(harness.nativeTunnelStarts).toHaveLength(1);
        expect(harness.nativeTunnelStops).toEqual(['workspace-download-lease-1']);
    });
    it('can fail the HTTP read and retry through a new prepared publication', async () => {
        harness.failNextChunk();
        const destination = createBufferedTransferDestination(3);
        const request = { ...harness.scope, request: { path: 'clip.mp4', asZip: false }, destination: destination.destination };
        expect(await downloadDaemonWorkspaceFileToDestination(request)).toMatchObject({ ok: false, errorCode: 'machine_carrier_transport_failed' });
        expect(destination.toBytes()).toEqual(new Uint8Array());
        expect(harness.nativeTunnelStarts).toHaveLength(1);
        expect(harness.nativeTunnelStops).toEqual(['workspace-download-lease-1']);
        expect(await downloadDaemonWorkspaceFileToDestination(request)).toEqual({ ok: true, name: 'clip.mp4', sizeBytes: 3 });
        expect(destination.toBytes()).toEqual(new Uint8Array([1, 2, 3]));
        expect(harness.nativeTunnelStarts).toHaveLength(2);
        expect(harness.nativeTunnelStops).toEqual(['workspace-download-lease-1', 'workspace-download-lease-2']);
    });
    it('preserves an authoritative finalize refusal while aborting only its prepared import', async () => {
        harness.failNextUploadFinalize();
        let closed = 0;
        const result = await uploadDaemonWorkspaceFileFromReader({ ...harness.scope,
            request: { path: 'upload.bin', sizeBytes: 3 },
            fileReader: { sizeBytes: 3, readBytes: async () => new Uint8Array([1, 2, 3]), close: async () => { closed += 1; } },
        });
        expect(result).toEqual({ success: false, error: 'Failed to finalize upload' });
        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toMatchObject({ aborted: true, finalized: false, finalizeAttempts: 1 });
        expect(closed).toBe(1);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('does not disclose a malformed import chunk response through its parser error', async () => {
        await harness.reset();
        const sentinel = 'untrusted-import-body';
        harness = await createDesktopHarness({ preparedHttpResponse: ({ path }, response) => path.includes('/imports/') && path.endsWith('/chunks/0')
            ? new Response(sentinel, { headers: { 'content-type': 'application/json' } }) : response });
        let closed = 0;
        const result = await uploadDaemonWorkspaceFileFromReader({ ...harness.scope,
            request: { path: 'upload.bin', sizeBytes: 3 },
            fileReader: { sizeBytes: 3, readBytes: async () => new Uint8Array([1, 2, 3]), close: async () => { closed += 1; } } });
        expect(JSON.stringify(result)).not.toContain(sentinel.slice(0, 10));
        expect(result).toEqual({ success: false, error: 'Direct import chunk returned an unsupported response' });
        expect(harness.uploads[0]).toMatchObject({ aborted: true, finalized: false, finalizeAttempts: 0 });
        expect(closed).toBe(1);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('retains a committed finalize outcome when its successful HTTP response contains malformed JSON', async () => {
        await harness.reset();
        harness = await createDesktopHarness({ preparedHttpResponse: ({ path }, response) => path.endsWith('/finalize')
            ? new Response('untrusted-finalize-body', { headers: { 'content-type': 'application/json' } }) : response });
        let closed = 0;
        const result = await uploadDaemonWorkspaceFileFromReader({ ...harness.scope,
            request: { path: 'upload.bin', sizeBytes: 3 },
            fileReader: { sizeBytes: 3, readBytes: async () => new Uint8Array([1, 2, 3]), close: async () => { closed += 1; } } });
        expect(result).toEqual({ success: false, error: 'Direct import finalize committed but returned an unusable result',
            errorCode: 'DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE' });
        expect(harness.uploads[0]).toMatchObject({ aborted: false, finalized: true, finalizeAttempts: 1 });
        expect(closed).toBe(1);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it.each(['Upload source reader exploded', 'Failed to fetch'])('preserves the local reader failure %s instead of blaming its carrier', async (message) => {
        let closed = 0;
        const result = await uploadDaemonWorkspaceFileFromReader({ ...harness.scope,
            request: { path: 'upload.bin', sizeBytes: 3 },
            fileReader: { sizeBytes: 3, readBytes: async () => { throw new TypeError(message); }, close: async () => { closed += 1; } },
        });
        expect(result).toEqual({ success: false, error: message });
        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toMatchObject({ aborted: true, finalized: false, finalizeAttempts: 0 });
        expect(harness.uploads[0]!.bytes).toEqual(new Uint8Array());
        expect(closed).toBe(1);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('preserves an oversized peer payload failure without publishing its destination', async () => {
        await harness.reset();
        harness = await createDesktopHarness({ advertisedDownloadSizeBytes: 1 });
        const bytes: number[] = [];
        let closed = false;
        let cleaned = 0;
        const result = await downloadDaemonWorkspaceFileToDestination({ ...harness.scope,
            request: { path: 'clip.mp4', asZip: false },
            destination: { writeBytes: async chunk => { bytes.push(...chunk); }, close: async () => { closed = true; },
                cleanup: async () => { cleaned += 1; bytes.length = 0; } },
        });
        expect(result).toEqual({ ok: false, error: 'Downloaded size exceeded expected size' });
        expect(bytes).toEqual([]);
        expect(closed).toBe(false);
        expect(cleaned).toBe(1);
        expect(harness.requests.filter(request => new URL(request.url).pathname.endsWith('/complete'))).toHaveLength(1);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('preserves a local destination failure even when its message resembles a network error', async () => {
        let cleaned = 0;
        let closed = false;
        const result = await downloadDaemonWorkspaceFileToDestination({ ...harness.scope,
            request: { path: 'clip.mp4', asZip: false },
            destination: { writeBytes: async () => { throw new TypeError('Failed to fetch'); },
                close: async () => { closed = true; }, cleanup: async () => { cleaned += 1; } },
        });
        expect(result).toEqual({ ok: false, error: 'Failed to fetch' });
        expect(closed).toBe(false);
        expect(cleaned).toBe(1);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('preserves a JSON publication integrity failure through the same prepared carrier', async () => {
        await harness.reset();
        const bytes = new TextEncoder().encode(JSON.stringify({ contents: 'verified only after complete bytes' }));
        harness = await createDesktopHarness({ bytes, advertisedDownloadSizeBytes: 1,
            composerInspection: { id: 'retained-composer-stage' } });
        const handle = harness.composerHandle;
        if (!handle) throw new Error('Composer fixture did not prepare its owned stage');
        const route = await resolveMachineCarrierRoute(harness.scope.machineId, harness.scope.serverId);
        if (route.kind === 'unavailable') throw new Error('Composer fixture Machine carrier was unavailable');
        const result = await downloadBulkJsonPayloadViaDirectExport({ machineId: harness.scope.machineId,
            serverId: harness.scope.serverId,
            request: { t: 'composer_media_stage_inspect_v1', handle, offset: 0, maxBytes: bytes.byteLength },
            parsePayload: value => value,
            acquirePreparedCarrier: prepared => route.acquire(prepared),
        });
        expect(result).toEqual({ ok: false, error: 'Direct export payload exceeded its declared size' });
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('treats an authentication response as terminal instead of trying the next destination endpoint', async () => {
        const download = await prepareJsonDownload({ downloadEndpointPorts: [46001, 46002],
            preparedHttpResponse: ({ path }, response) => path.endsWith('/open')
                ? Response.json({ error: 'untrusted response detail must not escape' }, { status: 401 }) : response });
        expect(await download()).toEqual({ ok: false, error: 'Direct export request failed with status 401' });
        expect(harness.requests.filter(request => new URL(request.url).pathname.endsWith('/open'))).toHaveLength(1);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('cancels an oversized streamed direct-export open body before consuming the whole response', async () => {
        let pulls = 0;
        let canceled = false;
        const download = await prepareJsonDownload({ preparedHttpResponse: ({ path }, response) => {
            if (!path.endsWith('/open')) return response;
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulls += 1;
                    if (pulls <= 10) controller.enqueue(new Uint8Array(4 * 1024).fill(32));
                    else controller.close();
                },
                cancel() { canceled = true; },
            }), { headers: { 'content-type': 'application/json' } });
        } });
        expect(await download()).toEqual({ ok: false, error: 'body_too_large' });
        expect(canceled).toBe(true);
        expect(pulls).toBeLessThan(10);
        expect(harness.requests.filter(request => new URL(request.url).pathname.endsWith('/open'))).toHaveLength(1);
    });
    it('keeps the direct-export request deadline active until the response body settles', async () => {
        let bodyAborted = false;
        let entered!: () => void;
        const responseEntered = new Promise<void>(resolve => { entered = resolve; });
        const download = await prepareJsonDownload({ preparedHttpResponse: ({ path, signal }, response) => {
            if (!path.endsWith('/open')) return response;
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                signal?.addEventListener('abort', () => {
                    bodyAborted = true;
                    controller.error(new DOMException('The operation was aborted', 'AbortError'));
                }, { once: true });
                setTimeout(() => { if (!bodyAborted) { controller.enqueue(new TextEncoder().encode('{')); controller.close(); } }, 100);
                entered();
            } }), { headers: { 'content-type': 'application/json' } });
        } }, 10);
        vi.useFakeTimers();
        try {
            const result = download();
            await responseEntered;
            await vi.advanceTimersByTimeAsync(10);
            const abortedAtDeadline = bodyAborted;
            await vi.advanceTimersByTimeAsync(100);
            expect(await result).toMatchObject({ ok: false, errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE });
            expect(abortedAtDeadline).toBe(true);
            expect(harness.nativeTunnelStops).toHaveLength(1);
        } finally { vi.useRealTimers(); }
    });
    it('derives the admitted chunk count from the JSON byte budget instead of a fixed one-million limit', async () => {
        const download = await prepareJsonDownload({ preparedHttpResponse: async ({ path }, response) => {
            if (path.endsWith('/open')) {
                const { sizeBytes: _sizeBytes, ...metadata } = await response.json();
                return Response.json({ ...metadata, totalChunks: 1_000_001 });
            }
            return path.endsWith('/chunks/0') ? Response.json({}) : response;
        } });
        expect(await download()).toEqual({ ok: false, error: 'Direct export chunk returned invalid payload' });
        expect(harness.requests.filter(request => /\/(open|chunks\/0)$/.test(new URL(request.url).pathname))).toHaveLength(2);
    });
    it.each(['HTTP response', 'decrypted payload'])('does not disclose malformed %s JSON through a parser error', async boundary => {
        const sentinel = 'untrusted-body-sentinel';
        const download = await prepareJsonDownload({ bytes: new TextEncoder().encode(sentinel),
            preparedHttpResponse: ({ path }, response) => boundary === 'HTTP response' && path.endsWith('/open')
                ? new Response(sentinel, { headers: { 'content-type': 'application/json' } }) : response });
        const result = await download();
        expect(JSON.stringify(result)).not.toContain(sentinel.slice(0, 10));
        expect(result).toEqual({ ok: false, error: 'Direct export download unavailable' });
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('preserves a local JSON consumer TypeError without blaming the completed HTTP request', async () => {
        const download = await prepareJsonDownload({ bytes: new TextEncoder().encode('{}') }, undefined,
            () => { throw new TypeError('Failed to fetch'); });
        expect(await download()).toEqual({ ok: false, error: 'Failed to fetch' });
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it.each([
        ['non-positive', '0'], ['fractional', '1.5'], ['non-finite', '1e400'],
        ['unsafe', String(Number.MAX_SAFE_INTEGER + 1)], ['size-inconsistent', '3'],
    ])('rejects a %s direct-export chunk count before requesting a chunk', async (_caseName, count) => {
        await harness.reset();
        harness = await createDesktopHarness({ bytes: new Uint8Array([1, 2]),
            preparedHttpResponse: async ({ path }, response) => path.endsWith('/open')
                ? new Response((await response.text()).replace('"totalChunks":1', `"totalChunks":${count}`),
                    { headers: { 'content-type': 'application/json' } }) : response });
        let writes = 0;
        let cleaned = 0;
        const result = await downloadDaemonWorkspaceFileToDestination({ ...harness.scope,
            request: { path: 'clip.mp4', asZip: false }, destination: {
                writeBytes: async () => { writes += 1; }, close: async () => { throw new Error('Invalid metadata must not publish'); },
                cleanup: async () => { cleaned += 1; },
            } });
        expect(result).toEqual({ ok: false, error: 'Direct export open returned invalid metadata' });
        expect(writes).toBe(0);
        expect(cleaned).toBe(1);
        expect(harness.requests.some(request => new URL(request.url).pathname.includes('/chunks/'))).toBe(false);
        expect(harness.requests.filter(request => new URL(request.url).pathname.endsWith('/complete'))).toHaveLength(1);
    });
    it('cancels an oversized streamed direct-export chunk body before consuming the whole response', async () => {
        await harness.reset();
        let pulls = 0;
        let canceled = false;
        harness = await createDesktopHarness({ preparedHttpResponse: ({ path }, response) => {
            if (!path.endsWith('/chunks/0')) return response;
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulls += 1;
                    if (pulls <= 10) controller.enqueue(new Uint8Array(256 * 1024).fill(32));
                    else controller.close();
                }, cancel() { canceled = true; },
            }), { headers: { 'content-type': 'application/json' } });
        } });
        const destination = createBufferedTransferDestination(3);
        expect(await downloadDaemonWorkspaceFileToDestination({ ...harness.scope,
            request: { path: 'clip.mp4', asZip: false }, destination: destination.destination }))
            .toEqual({ ok: false, error: 'body_too_large' });
        expect(canceled).toBe(true);
        expect(pulls).toBeLessThan(10);
        expect(destination.toBytes()).toEqual(new Uint8Array());
        expect(harness.requests.filter(request => new URL(request.url).pathname.endsWith('/complete'))).toHaveLength(1);
    });
    it('exposes the real HTTP abort signal while a response arrives after cancellation', async () => {
        const deferred = harness.deferNextChunk();
        const controller = new AbortController();
        const destination = createBufferedTransferDestination(3);
        const pending = downloadDaemonWorkspaceFileToDestination({ ...harness.scope, request: { path: 'clip.mp4', asZip: false }, destination: destination.destination, signal: controller.signal });
        await deferred.entered;
        controller.abort();
        expect(harness.requests.at(-1)?.signal?.aborted).toBe(true);
        deferred.release();
        expect(await pending).toMatchObject({ ok: false });
        expect(destination.toBytes()).toEqual(new Uint8Array());
    });
});
