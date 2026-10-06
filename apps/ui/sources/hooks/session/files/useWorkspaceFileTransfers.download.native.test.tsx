import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';

const nativeOpenSpy = vi.hoisted(() => vi.fn());
const nativeCloseSpy = vi.hoisted(() => vi.fn());
const nativeDeleteSpy = vi.hoisted(() => vi.fn());
const nativeWriteSpy = vi.hoisted(() => vi.fn());

installSessionFilesViewBoundaries();

// Expo owns native filesystem custody; the transfer and cleanup owners stay real.
vi.mock('expo-file-system', () => {
    class FakeDirectory {
        uri: string;
        constructor(parent: { uri: string } | string, name?: string) {
            const parentUri = typeof parent === 'string' ? parent : parent.uri;
            this.uri = name ? `${parentUri.replace(/\/+$/, '')}/${name}` : parentUri;
        }
        create() {}
    }

    class FakeFileHandle {
        offset: number | null = 0;
        size: number | null = 4;
        close() { nativeCloseSpy(); }
        readBytes(_length: number): Uint8Array { return new Uint8Array([1, 2, 3, 4]); }
        writeBytes(bytes: Uint8Array): void { nativeWriteSpy(new Uint8Array(bytes)); }
    }

    class FakeFile {
        uri: string;
        constructor(parent: { uri: string } | string, name?: string) {
            const parentUri = typeof parent === 'string' ? parent : parent.uri;
            this.uri = name ? `${parentUri.replace(/\/+$/, '')}/${name}` : parentUri;
        }
        create() {}
        open() { nativeOpenSpy(); return new FakeFileHandle(); }
        delete() { nativeDeleteSpy(); }
    }

    return { Directory: FakeDirectory, File: FakeFile, Paths: { cache: { uri: 'file:///cache' } } };
});

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let corruptManifest = false;
beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    standardCleanup();
    nativeOpenSpy.mockReset();
    nativeCloseSpy.mockReset();
    nativeDeleteSpy.mockReset();
    nativeWriteSpy.mockReset();
    corruptManifest = false;
    transfer = createSessionFileNativeTransferBoundary({ bytes: new Uint8Array([1, 2, 3, 4]), name: 'report.txt' });
    fixture = await createSessionFilesViewFixture({
        rootPath: '/repo', machineCarrierOrigin: transfer.origin, rpc: transfer.rpc,
        request: async (url, init) => {
            const response = await transfer.request(url, init);
            if (!corruptManifest || !new URL(String(url)).pathname.endsWith('/open') || !response.ok) return response;
            // A validly shaped but corrupted daemon manifest fails only after
            // actual encrypted bytes have reached the native destination.
            const manifest: unknown = await response.json();
            if (!manifest || typeof manifest !== 'object' || !('manifestHash' in manifest) || typeof manifest.manifestHash !== 'string') {
                throw new Error('Expected transfer manifest');
            }
            const hash = manifest.manifestHash;
            if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error('Expected SHA-256 transfer manifest');
            return Response.json({ ...manifest, manifestHash: `sha256:${hash[7] === '0' ? '1' : '0'}${hash.slice(8)}` });
        },
    });
});
afterEach(async () => {
    standardCleanup();
    await fixture?.dispose();
    vi.doUnmock('expo-sharing');
});

async function mountTransfers() {
    const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');
    let api: ReturnType<typeof useWorkspaceFileTransfers> | undefined;
    function Test() { api = useWorkspaceFileTransfers({ workspaceScope: fixture.scope }); return null; }
    const screen = await fixture.render(<Test />);
    if (!api) throw new Error('expected hook api');
    return { api, screen };
}

function expectNativeCustody() {
    expect(nativeWriteSpy).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]));
    expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
    expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    expect(nativeDeleteSpy).toHaveBeenCalledTimes(2);
    expect(transfer.prepares).toEqual([expect.objectContaining({ targetId: fixture.scope.machineId,
        payload: expect.objectContaining({ path: '/repo/report.txt', asZip: false }) })]);
    expect(transfer.grantRequests).toEqual([expect.objectContaining({ machineId: fixture.scope.machineId })]);
    expect(transfer.nativeStops).toHaveBeenCalledTimes(1);
}

describe('useWorkspaceFileTransfers native download cleanup', () => {
    it('cleans up the native download sink when the canonical helper returns a failure', async () => {
        const { MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease');
        corruptManifest = true;
        const shareAsync = vi.fn(async () => undefined);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync }));
        const { api } = await mountTransfers();
        let result: Awaited<ReturnType<typeof api.startDownload>> | undefined;
        await act(async () => { result = await api.startDownload({ path: 'report.txt', asZip: false }); });
        expect(result).toEqual({ ok: false, error: MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR });
        expect(shareAsync).not.toHaveBeenCalled();
        expectNativeCustody();
    });

    it('cleans up the native download sink after a successful share', async () => {
        const shareAsync = vi.fn(async () => undefined);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync }));
        const { api } = await mountTransfers();
        let result: Awaited<ReturnType<typeof api.startDownload>> | undefined;
        await act(async () => { result = await api.startDownload({ path: 'report.txt', asZip: false }); });
        expect(result).toEqual({ ok: true });
        expect(shareAsync).toHaveBeenCalledWith('file:///cache/happier-downloads/report.txt', undefined);
        expectNativeCustody();
    });

    it.each(['cancel', 'unmount'] as const)('does not share after native availability settles following %s', async (interruption) => {
        const availabilityStarted = createDeferred<void>();
        const availability = createDeferred<boolean>();
        const isAvailableAsync = vi.fn(async () => { availabilityStarted.resolve(); return await availability.promise; });
        const shareAsync = vi.fn(async () => undefined);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync, shareAsync }));
        const { api, screen } = await mountTransfers();
        let download: ReturnType<typeof api.startDownload> | undefined;
        await act(async () => {
            download = api.startDownload({ path: 'report.txt', asZip: false });
            await availabilityStarted.promise;
        });
        await act(async () => {
            if (interruption === 'cancel') api.cancelDownload();
            else await screen.unmount();
            availability.resolve(true);
        });
        if (!download) throw new Error('expected download promise');
        await expect(download).resolves.toEqual({ ok: false, error: 'Download canceled', canceled: true });
        expect(isAvailableAsync).toHaveBeenCalledTimes(1);
        expect(shareAsync).not.toHaveBeenCalled();
        expectNativeCustody();
    });
});
