import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { decryptArtifactWithBody } from '@/sync/engine/artifacts/syncArtifacts';
import { sync } from '@/sync/sync';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});
import { ArtifactView } from './ArtifactView';

const initialState = getStorage().getState();
const platform = Platform.OS;
let disposeHome: (() => void) | undefined;
afterEach(async () => {
    await act(async () => {
        disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        getStorage().setState(initialState, true);
    });
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    vi.restoreAllMocks();
});

function OpenView({ id }: Readonly<{ id: string }>) {
    const artifact = getStorage()(state => state.artifacts[id] ?? null);
    return <ArtifactView artifactId={id} artifact={artifact} presentation="page" />;
}

async function setup(kind: 'image' | 'html' | 'file', delayBlob?: Promise<Response>, warm = false,
    override?: (request: ServedHomeRequest) => Response | Promise<Response> | undefined) {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const bytes = new TextEncoder().encode(kind === 'html' ? '<!doctype html><h1>Saved HTML</h1>' : 'Private bytes');
    const reference = { blobId: 'e704b26f-9c31-4728-9590-858378e34ed9', mime: kind === 'html' ? 'text/html' : kind === 'image' ? 'image/png' : 'application/zip',
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    const row: DecryptedArtifact = { id: 'document', title: 'Saved', header: { kind: kind === 'html' ? 'html' : 'artifact.legacy', title: 'Saved' },
        isDecrypted: true, body: warm ? reference : undefined, storageMode: 'plain', ownerAccountId: 'owner', access: 'owner',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const head: Artifact = { id: row.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        header: encodePlainArtifactStoredContent(row.header), body: encodePlainArtifactStoredContent({ body: reference }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
    const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://view.test', accountId: 'owner' }], route: request => {
        const overridden = override?.(request);
        if (overridden !== undefined) return overridden;
        if (request.path === '/v1/artifacts/document') return Response.json(head);
        if (request.path.includes('/blobs/')) return delayBlob ?? Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        if (request.path.endsWith('/html-preview')) return Response.json({ url: 'https://document.preview.test/a/document' });
    } });
    disposeHome = served.dispose;
    await loadSyncSingletonForTests();
    // This Node renderer has no browser sessionStorage for a tab-scoped selection.
    await upsertAndActivateServer({ serverUrl: served.homes.owner!.serverUrl, scope: 'device' });
    expect(getActiveServerSnapshot().serverUrl).toBe(served.homes.owner!.serverUrl);
    // Seed the real singleton's authenticated state; no sync or crypto behavior is substituted.
    const initialized = sync as unknown as { credentials: AuthCredentials | null; encryption: Encryption | null };
    initialized.credentials = await TokenStorage.getCredentialsForServerUrl(served.homes.owner!.serverUrl);
    initialized.encryption = null;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    setServerReachabilityNetworkAllowed(true);
    const storedRow = warm ? await decryptArtifactWithBody({ artifact: head, encryption: null, artifactDataKeys: new Map() }) : row;
    if (!storedRow) throw new Error('Missing warm Artifact');
    getStorage().getState().addArtifact(storedRow);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { served, head, row, bytes, reference };
}

describe('Artifact composed view reads', () => {
    it.each([{ kind: 'image', warm: false }, { kind: 'html', warm: false }, { kind: 'image', warm: true }, { kind: 'html', warm: true }] as const)(
        'opens $kind (warm=$warm) through one authenticated head and renders its private preview', async ({ kind, warm }) => {
        const { served } = await setup(kind, undefined, warm);
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(kind === 'image' ? screen.findByTestId('file:imagePreview') : screen.findByTestId('artifact:htmlPreview')).not.toBeNull());
        const heads = served.requests.filter(request => request.path === '/v1/artifacts/document');
        console.info('Artifact view measurement', { kind, warm, heads: heads.length,
            blobs: served.requests.filter(request => request.path.includes('/blobs/')).length,
            shells: served.requests.filter(request => request.path.endsWith('/html-preview')).length });
        expect(heads).toHaveLength(1);
        expect(served.requests.every(request => request.accountId === 'owner')).toBe(true);
        await screen.unmount();
    });

    it('leaves a generic file download deferred and suppresses a preview after Account retirement', async () => {
        const { served } = await setup('file');
        const file = await renderScreen(<OpenView id="document" />);
        await flushHookEffects();
        await vi.waitFor(() => expect(file.findByTestId('artifact:download')).not.toBeNull());
        expect(served.requests.some(request => request.path.includes('/blobs/'))).toBe(false);
        await file.unmount();
        disposeHome?.();
        const pending = createDeferred<Response>();
        const next = await setup('image', pending.promise);
        const image = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(next.served.requests.some(request => request.path.includes('/blobs/'))).toBe(true));
        retireActiveServerAccountScopeLifetime();
        pending.resolve(Response.json({ blobId: 'e704b26f-9c31-4728-9590-858378e34ed9', content: { t: 'plain', v: encodeBase64(new TextEncoder().encode('Private bytes')) } }));
        await flushHookEffects();
        expect(image.findByTestId('file:imagePreview') === null).toBe(true);
        await image.unmount();
    });

    it('reopens an HTML frame retry through fresh Account authority without repeating a head within either operation', async () => {
        const { served } = await setup('html');
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(screen.findByTestId('artifact:htmlPreview')).not.toBeNull());
        await act(async () => { screen.tree.root.findByType('iframe').props.onError(); });
        await screen.pressByTestIdAsync('artifact:htmlPreviewRetry');
        await vi.waitFor(() => expect(screen.findByTestId('artifact:htmlPreview')).not.toBeNull());
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(served.requests.filter(request => request.path.endsWith('/html-preview'))).toHaveLength(2);
        await screen.unmount();
    });

    it('cancels a superseded revision and does not install its late private preview', async () => {
        const pending = createDeferred<Response>();
        let blobReads = 0;
        const { served, head, row, bytes, reference } = await setup('image', undefined, false, request => {
            if (!request.path.includes('/blobs/')) return;
            if (++blobReads === 1) return pending.promise;
            return Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        });
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(blobReads).toBe(1));
        head.headerVersion = 2;
        head.bodyVersion = 2;
        await act(async () => { getStorage().getState().updateArtifact({ ...row, headerVersion: 2, bodyVersion: 2 }); });
        await vi.waitFor(() => expect(screen.findByTestId('file:imagePreview')).not.toBeNull());
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(2);
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        pending.resolve(Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } }));
        await flushHookEffects();
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
});
