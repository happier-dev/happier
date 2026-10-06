import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';
import { createSessionFileNativeTransferBoundary } from '../../sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '../../views/sessionFilesViewTestkit';
import { useSessionImagePreview } from './useSessionImagePreview';

const files = vi.hoisted(() => new Map<string, { exists: boolean; chunks: Uint8Array[]; closed: number; deletes: number }>());
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
// Expo's OS-backed file API is the sink boundary. The real preview source owns custody.
vi.mock('expo-file-system', () => ({
    Paths: { cache: 'file:///preview-cache' },
    Directory: class Directory {
        readonly uri: string;
        constructor(parent: string | { uri: string }, name?: string) { this.uri = (typeof parent === 'string' ? parent : parent.uri) + (name ? '/' + name : ''); }
        create() {}
    },
    File: class File {
        readonly uri: string;
        constructor(parent: string | { uri: string }, name?: string) {
            this.uri = (typeof parent === 'string' ? parent : parent.uri) + (name ? '/' + name : '');
            if (!files.has(this.uri)) files.set(this.uri, { exists: false, chunks: [], closed: 0, deletes: 0 });
        }
        create() { files.get(this.uri)!.exists = true; }
        delete() { const file = files.get(this.uri)!; file.exists = false; file.deletes++; }
        open() { const file = files.get(this.uri)!; return {
            offset: 0,
            writeBytes: (bytes: Uint8Array) => file.chunks.push(new Uint8Array(bytes)),
            close: () => { file.closed++; },
        }; }
    },
}));

describe('useSessionImagePreview', () => {
    let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    beforeAll(prepareSessionFilesViewTestkit);
    beforeEach(async () => {
        files.clear();
        transfer = createSessionFileNativeTransferBoundary();
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', machineCarrierOrigin: transfer.origin, rpc: transfer.rpc, request: transfer.request });
        fixture.storage.getState().applySettingsLocal({
            filesImagePreviewCacheMaxEntries: 10, filesImagePreviewCacheMaxTotalBytes: 1_000_000, filesImagePreviewMaxBytes: 1_000_000,
        });
    });
    afterEach(async () => { await fixture.dispose(); });

    it('waits for the session workspace target and retries once it becomes available', async () => {
        fixture.storage.getState().applySessions([{ ...fixture.session, metadata: null }]);
        const hook = await renderHook(() => useSessionImagePreview({
            sessionId: fixture.session.id, filePath: '.happier/uploads/messages/m1/file.png',
            enabled: true, cacheKey: 'sha-1', mimeType: 'image/png', sizeBytes: 3,
        }));
        expect(hook.getCurrent()).toEqual({ status: 'loading', uri: null, error: null });
        expect(transfer.prepares).toEqual([]);

        await act(async () => fixture.storage.getState().applySessions([fixture.session]));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        expect(transfer.prepares.map((request) => request.payload)).toEqual([{
            t: 'workspace_file_download_v1', workingDirectory: '/repo',
            path: '/repo/.happier/uploads/messages/m1/file.png', asZip: false,
        }]);
        expect(transfer.prepares[0]?.targetId).toBe(fixture.scope.machineId);
        expect(hook.getCurrent().uri?.startsWith('data:')).toBe(false);
        const file = files.get(hook.getCurrent().uri!);
        expect(file?.chunks.flatMap((chunk) => [...chunk])).toEqual([97, 98, 99]);
        await hook.unmount();
    });

    it('loads an opaque staged composer image through the incumbent preview cache without resolving a session workspace path', async () => {
        const handle: ComposerContentHandleV1 = {
            v: 1, id: 'stage_42', executionTarget: { serverId: fixture.scope.serverId, machineId: fixture.scope.machineId },
            owner: { pluginId: 'acme.images', localId: 'image' }, mediaKind: 'image',
            mimeType: 'image/png', name: 'incident.png', sizeBytes: 3, sha256: 'a'.repeat(64),
        };
        fixture.storage.getState().applySessions([{ ...fixture.session, metadata: null }]);
        const hook = await renderHook(({ staged }: { staged: ComposerContentHandleV1 }) => useSessionImagePreview({
            sessionId: '', filePath: staged.name, enabled: true, composerStagedMedia: staged,
        }), { initialProps: { staged: handle } });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        expect(transfer.prepares.map((request) => request.payload)).toEqual([{
            t: 'composer_media_stage_inspect_v1', handle, offset: 0, maxBytes: 3,
        }]);
        expect(files.get(hook.getCurrent().uri!)?.chunks.flatMap((chunk) => [...chunk])).toEqual([97, 98, 99]);
        // A replacement opaque stage is cancelled at the real HTTP boundary,
        // not inferred from a settled request's already-disposed signal.
        const gate = transfer.deferNextOpen();
        await hook.rerender({ staged: { ...handle, id: 'stage_43', sha256: 'b'.repeat(64) } });
        await vi.waitFor(() => expect(transfer.prepares).toHaveLength(2));
        await vi.waitFor(() => expect(transfer.httpRequests.filter((request) => request.url.endsWith('/open'))).toHaveLength(2));
        const pendingRequest = transfer.httpRequests.at(-1)!;
        await hook.unmount();
        expect(pendingRequest.signal?.aborted).toBe(true);
        gate.resolve();
        await vi.waitFor(() => expect(transfer.nativeStops).toHaveBeenCalledTimes(2));
    });

    it('cleans up a preview source when its transfer resolves after unmount', async () => {
        const gate = transfer.deferNextOpen();
        const hook = await renderHook(() => useSessionImagePreview({
            sessionId: fixture.session.id, filePath: '.happier/uploads/messages/m1/file.png',
            enabled: true, cacheKey: null, mimeType: 'image/png', sizeBytes: 3,
        }));
        await vi.waitFor(() => expect(transfer.httpRequests.some((request) => request.url.endsWith('/open'))).toBe(true));
        expect([...files.values()].some((file) => file.exists)).toBe(true);
        await hook.unmount();
        expect(transfer.httpRequests[0]?.signal?.aborted).toBe(true);
        gate.resolve();
        await vi.waitFor(() => expect([...files.values()].every((file) => !file.exists)).toBe(true));
        expect([...files.values()].every((file) => file.closed === 1 && file.deletes >= 2)).toBe(true);
        await vi.waitFor(() => expect(transfer.nativeStops).toHaveBeenCalledTimes(1));
    });

    it('keeps one in-flight transfer for equivalent workspace scope objects and publishes its URI once', async () => {
        const gate = transfer.deferNextOpen();
        const hook = await renderHook(({ workspaceScope }: { workspaceScope: typeof fixture.scope }) => useSessionImagePreview({
            sessionId: fixture.session.id, filePath: '.happier/uploads/messages/m1/file.png',
            enabled: true, cacheKey: null, mimeType: 'image/png', sizeBytes: 3, workspaceScope,
            cacheScopeId: 'stable-scope',
        }), { initialProps: { workspaceScope: { ...fixture.scope } } });
        await vi.waitFor(() => expect(transfer.prepares).toHaveLength(1));
        await hook.rerender({ workspaceScope: { ...fixture.scope } });
        expect(transfer.prepares).toHaveLength(1);
        gate.resolve();
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        const uri = hook.getCurrent().uri!;
        expect(files.get(uri)?.exists).toBe(true);
        expect(files.get(uri)?.deletes).toBe(1);
        await hook.unmount();
        await vi.waitFor(() => expect(files.get(uri)?.exists).toBe(false));
        expect(files.get(uri)?.closed).toBe(1);
    });

    it('releases the prior uncached source when the logical file identity changes', async () => {
        const hook = await renderHook(({ filePath }: { filePath: string }) => useSessionImagePreview({
            sessionId: fixture.session.id, filePath, enabled: true, cacheKey: null, mimeType: 'image/png',
            workspaceScope: fixture.scope, cacheScopeId: 'identity-scope',
        }), { initialProps: { filePath: '.happier/uploads/messages/m1/first.png' } });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        const firstUri = hook.getCurrent().uri!;
        transfer.setPayload(new Uint8Array([97, 98, 99, 100]), 'second.png');
        await hook.rerender({ filePath: '.happier/uploads/messages/m1/second.png' });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('loaded'));
        const secondUri = hook.getCurrent().uri!;
        expect(transfer.prepares).toHaveLength(2);
        expect(secondUri).not.toBe(firstUri);
        expect(files.get(firstUri)?.exists).toBe(false);
        expect(files.get(firstUri)?.closed).toBe(1);
        expect(files.get(secondUri)?.chunks.flatMap((chunk) => [...chunk])).toEqual([97, 98, 99, 100]);
        await hook.unmount();
        await vi.waitFor(() => expect(files.get(secondUri)?.exists).toBe(false));
        expect(files.get(secondUri)?.closed).toBe(1);
    });
});
