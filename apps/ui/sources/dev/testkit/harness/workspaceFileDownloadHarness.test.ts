import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceFileDownloadHarness } from './workspaceFileDownloadHarness';
import { downloadDaemonWorkspaceFileToDestination } from '@/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers';
import { createBufferedTransferDestination } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/createBufferedTransferDestination';

describe('workspace download genuine boundary harness', () => {
    const previousPlatform = Platform.OS;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;
    beforeEach(async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        harness = await createWorkspaceFileDownloadHarness();
    });
    afterEach(async () => {
        await harness?.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
    });
    it('downloads the actual encrypted prepared publication through the real workspace owner', async () => {
        const destination = createBufferedTransferDestination(3);
        const result = await downloadDaemonWorkspaceFileToDestination({ ...harness.scope, request: { path: 'clip.mp4', asZip: false }, destination: destination.destination });
        expect(result).toEqual({ ok: true, name: 'clip.mp4', sizeBytes: 3 });
        expect(destination.toBytes()).toEqual(new Uint8Array([1, 2, 3]));
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('can fail the HTTP read and retry through a new prepared publication', async () => {
        harness.failNextChunk();
        const destination = createBufferedTransferDestination(3);
        const request = { ...harness.scope, request: { path: 'clip.mp4', asZip: false }, destination: destination.destination };
        expect(await downloadDaemonWorkspaceFileToDestination(request)).toMatchObject({ ok: false, errorCode: 'machine_carrier_transport_failed' });
        expect(destination.toBytes()).toEqual(new Uint8Array());
        expect(await downloadDaemonWorkspaceFileToDestination(request)).toEqual({ ok: true, name: 'clip.mp4', sizeBytes: 3 });
        expect(destination.toBytes()).toEqual(new Uint8Array([1, 2, 3]));
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
