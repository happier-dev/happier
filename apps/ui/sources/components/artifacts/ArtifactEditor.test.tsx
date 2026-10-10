import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { installRealActionExecutorModuleLoader, serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { getStorage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { ActionsSettingsV1Schema, ApprovalRequestSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const navigation = vi.hoisted(() => ({ canGoBack: true, back: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ router: { canGoBack: () => navigation.canGoBack,
        back: navigation.back, replace: navigation.replace, push: navigation.push } }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactEditor } from './ArtifactEditor';

describe('ArtifactEditor', () => {
    const initialState = getStorage().getState();
    let disposeHome: (() => void) | undefined;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    afterEach(async () => {
        await connection?.dispose();
        connection = undefined;
        disposeHome?.();
        disposeHome = undefined;
        await act(async () => { getStorage().setState(initialState, true); });
        vi.restoreAllMocks();
    });
    beforeEach(() => {
        navigation.canGoBack = true;
        navigation.back.mockClear();
        navigation.replace.mockClear();
        navigation.push.mockClear();
        vi.mocked(Modal.alert).mockClear();
    });

    it('saves against the opening full revision after another writer advances the head, retaining the refused draft', async () => {
        const opening: DecryptedArtifact = { id: 'document', title: 'Opening', isDecrypted: true,
            header: { kind: 'artifact.legacy', title: 'Opening' }, rawHeader: { kind: 'artifact.legacy', title: 'Opening' },
            body: 'Opening body', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
        const current = { ...opening, title: 'Concurrent', body: 'Concurrent body', headerVersion: 2, bodyVersion: 2,
            header: { kind: 'artifact.legacy', title: 'Concurrent' }, rawHeader: { kind: 'artifact.legacy', title: 'Concurrent' } };
        const homes = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(homes);
        await homes.reset();
        const serverId = await homes.addHome({ name: 'Editor', serverUrl: 'https://artifact-editor-cas.test', accountId: 'owner' });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        await loadSyncSingletonForTests();
        disposeHome = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://artifact-editor-cas.test', accountId: 'owner', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        const { sync } = await import('@/sync/sync');
        const id = await sync.createArtifactWithHeader(opening.rawHeader!, opening.body ?? '');
        opening.id = id;
        current.id = id;
        const screen = await renderScreen(<ArtifactEditor artifact={opening} mode="edit" />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body', 'My draft'); });
        await act(async () => { await sync.updateArtifactWithHeader(id, current.rawHeader, current.body,
            { expectedRevision: { headerVersion: 1, bodyVersion: 1 } }); });
        await screen.update(<ArtifactEditor artifact={current} mode="edit" />);
        await screen.pressByTestIdAsync('artifact-editor:save');
        const writes = homes.requestsFor(`/v1/artifacts/${id}`).filter(request => request.input !== null);
        expect(writes.at(-1)?.input).toMatchObject({ expectedHeaderVersion: 1, expectedBodyVersion: 1 });
        expect(homes.artifacts(serverId).readPlainBody(id)).toBe('Concurrent body');
        expect(screen.findByTestId('artifact-editor:body')?.props.value).toBe('My draft');
        expect(screen.findByTestId('artifact-editor:title')?.props.value).toBe('Opening');
        expect(navigation.back).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(screen.findByTestId('artifact-editor:conflict')).not.toBeNull();
        await screen.unmount();
    });

    it.each(['new', 'edit'] as const)('routes a policy-required %s save to its approval without discarding the draft', async mode => {
        await loadSyncSingletonForTests();
        const artifact: DecryptedArtifact = { id: 'approval-document', title: 'Opening', isDecrypted: true,
            header: { kind: 'artifact.legacy', title: 'Opening' }, rawHeader: { kind: 'artifact.legacy', title: 'Opening' },
            body: 'Opening body', headerVersion: 3, bodyVersion: 7, seq: 1, createdAt: 1, updatedAt: 1,
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-editor-approval.test', accountId: 'owner' }],
            route: request => request.path === `/v1/artifacts/${artifact.id}` && request.method === 'GET'
                ? Response.json({ ...artifact, encryptionMode: 'plain', publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent(artifact.header), body: encodePlainArtifactStoredContent({ body: artifact.body }) })
                : persisted.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined });
        disposeHome = served.dispose;
        getStorage().setState(state => ({ settings: { ...state.settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'artifact.create': { approvalRequiredSurfaces: ['ui'] }, 'artifact.update': { approvalRequiredSurfaces: ['ui'] },
            } }) } }));
        const screen = await renderScreen(<ArtifactEditor artifact={mode === 'edit' ? artifact : null} mode={mode} />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body', 'Approval draft'); });
        await screen.pressByTestIdAsync('artifact-editor:save');
        const approval = persisted.list()[0];
        expect(approval).toBeDefined();
        const request = ApprovalRequestSchema.parse(JSON.parse(persisted.readPlainBody(approval!.id)!));
        expect(request).toMatchObject({ actionId: mode === 'new' ? 'artifact.create' : 'artifact.update',
            actionArgs: { body: 'Approval draft', ...(mode === 'edit' ? { expectedRevision: { headerVersion: 3, bodyVersion: 7 } } : {}) } });
        expect(navigation.push).toHaveBeenCalledWith(`/inbox/approvals/${approval!.id}?serverId=${encodeURIComponent(served.homes.owner!.id)}`);
        expect(navigation.back).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(screen.findByTestId('artifact-editor:body')?.props.value).toBe('Approval draft');
        expect(served.requests.filter(request => request.method === 'POST' && request.path === `/v1/artifacts/${artifact.id}`)).toEqual([]);
        await screen.unmount();
    });

    it('returns to the collection when responsive navigation loses its back stack', async () => {
        await loadSyncSingletonForTests();
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        navigation.canGoBack = false;
        await screen.pressByTestIdAsync('artifact-editor:cancel');
        expect(navigation.replace).toHaveBeenCalledWith('/artifacts');
        expect(navigation.back).not.toHaveBeenCalled();
    });

    it('creates and updates a Markdown document through the real admitted Action and acknowledged store publication', async () => {
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-editor-success.test', accountId: 'owner' }],
            route: request => persisted.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined });
        disposeHome = served.dispose;
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body', 'First body'); });
        await screen.pressByTestIdAsync('artifact-editor:save');
        const stored = persisted.list()[0];
        expect(stored).toBeDefined();
        expect(navigation.replace).toHaveBeenCalledWith(`/artifacts/${stored!.id}`);
        expect(persisted.readPlainBody(stored!.id)).toBe('First body');
        await screen.unmount();
        const artifact = getStorage().getState().artifacts[stored!.id]!;
        const editor = await renderScreen(<ArtifactEditor artifact={artifact} mode="edit" />);
        await act(async () => { editor.changeTextByTestId('artifact-editor:body', 'Second body'); });
        await editor.pressByTestIdAsync('artifact-editor:save');
        expect(persisted.readPlainBody(stored!.id)).toBe('Second body');
        expect(getStorage().getState().artifacts[stored!.id]).toMatchObject({ body: 'Second body', headerVersion: 2, bodyVersion: 2 });
        expect(navigation.back).toHaveBeenCalledOnce();
        await editor.unmount();
    });

    it('keeps the draft and reports the named budget when the create Action refuses quota', async () => {
        const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://artifact-editor-quota.test', accountId: 'owner' }],
            route: request => request.path === '/v1/artifacts' && request.method === 'POST'
                ? Response.json({ error: 'quota_exceeded', budget: 'document', limitBytes: 1, usedBytes: 10 }, { status: 413 }) : undefined });
        disposeHome = served.dispose;
        const screen = await renderScreen(<ArtifactEditor artifact={null} mode="new" />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body', 'My document'); });
        await screen.pressByTestIdAsync('artifact-editor:save');
        expect(screen.findByTestId('artifact-editor:quota')).not.toBeNull();
        expect(screen.getTextContent()).toContain('artifacts.browser.quota.documentTitle');
        expect(screen.findByTestId('artifact-editor:body')?.props.value).toBe('My document');
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('opens a distinct draft when a hydrated document route changes identity', async () => {
        await loadSyncSingletonForTests();
        const { EditArtifactContent } = await import('@/app/(app)/artifacts/edit/[id]');
        const first: DecryptedArtifact = { id: 'first', title: 'First', body: 'First body',
            header: { title: 'First' }, rawHeader: { title: 'First' }, headerVersion: 1, bodyVersion: 1,
            isDecrypted: true, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'plain' };
        const second = { ...first, id: 'second', title: 'Second', body: 'Second body',
            header: { title: 'Second' }, rawHeader: { title: 'Second' }, headerVersion: 4, bodyVersion: 6 };
        const screen = await renderScreen(<EditArtifactContent id={first.id} artifact={first} />);
        await act(async () => { screen.changeTextByTestId('artifact-editor:body', 'First draft'); });
        await screen.update(<EditArtifactContent id={second.id} artifact={second} />);
        expect(screen.findByTestId('artifact-editor:body')?.props.value).toBe('Second body');
        expect(screen.findByTestId('artifact-editor:title')?.props.value).toBe('Second');
        await screen.unmount();
    });

    it('does not expose a text Save that can erase a binary file opened through a direct edit route', async () => {
        await loadSyncSingletonForTests();
        const artifact: DecryptedArtifact = { id: 'binary', title: 'archive.zip', isDecrypted: true,
            header: { kind: 'artifact.legacy', title: 'archive.zip' }, rawHeader: { kind: 'artifact.legacy', title: 'archive.zip' },
            body: { blobId: 'a668646c-dc5f-464d-9e49-285c03698cc9', mime: 'application/zip', sizeBytes: 0, sha256: '0'.repeat(64) },
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        const screen = await renderScreen(<ArtifactEditor artifact={artifact} mode="edit" />);
        expect(screen.findByTestId('artifact-editor:save')).toBeNull();
        expect(screen.findByTestId('artifact:download')).not.toBeNull();
    });
});
