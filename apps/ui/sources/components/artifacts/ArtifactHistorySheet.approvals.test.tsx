import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { ActionsSettingsV1Schema, ApprovalRequestSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { Modal, ModalProvider } from '@/modal';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

const initialState = getStorage().getState();
let disposeHome: (() => void) | undefined;
afterEach(async () => {
    await act(async () => {
        Modal.hideAll();
        disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialState, true);
    });
    vi.restoreAllMocks();
});

describe('Artifact History pending approval', () => {
    it('opens the persisted Restore approval and closes History without executing the restore', async () => {
        const artifact = { id: 'document', title: 'Notes', isDecrypted: true as const, header: { title: 'Notes' },
            headerVersion: 1, bodyVersion: 2, seq: 1, body: 'Current', createdAt: 1, updatedAt: 2,
            access: 'owner' as const, storageMode: 'plain' as const };
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-history-approval.test', accountId: 'owner' }],
            route: request => request.path === '/v1/artifacts/document' && request.method === 'GET'
                ? Response.json({ ...artifact, ownerAccountId: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent(artifact.header), body: encodePlainArtifactStoredContent({ body: artifact.body }) })
                : request.path === '/v1/artifacts/document/revisions'
                    ? Response.json({ revisions: [{ bodyVersion: 1, body: encodePlainArtifactStoredContent({ body: 'Earlier' }),
                        createdAt: 1, sizeBytes: 7 }], retentionCount: 10 })
                    : persisted.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined,
        });
        disposeHome = served.dispose;
        getStorage().getState().addArtifact(artifact);
        getStorage().setState(state => ({ settings: { ...state.settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'artifact.revisions.restore': { approvalRequiredSurfaces: ['ui'] },
            } }) } }));
        const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        await act(async () => { showArtifactHistorySheet({ artifactId: artifact.id, name: artifact.title, canRestore: true }); });
        await flushHookEffects();
        const restore = screen.findByTestId('artifact-history:restore');
        expect(restore).not.toBeNull();
        await screen.pressByTestIdAsync('artifact-history:restore');
        await flushHookEffects();
        const approval = persisted.list().find(row => row.id !== artifact.id);
        expect(approval).toBeDefined();
        expect(ApprovalRequestSchema.parse(JSON.parse(persisted.readPlainBody(approval!.id)!)))
            .toMatchObject({ actionId: 'artifact.revisions.restore', status: 'open', actionArgs: { artifactId: artifact.id, bodyVersion: 1 } });
        expect(served.requests.some(request => request.path.endsWith('/restore'))).toBe(false);
        expect(router.push).toHaveBeenLastCalledWith(`/inbox/approvals/${encodeURIComponent(approval!.id)}?serverId=${encodeURIComponent(served.homes.owner!.id)}`);
        expect(screen.findHostByTestId('artifact-history')).toBeNull();
        expect(getStorage().getState().artifacts[artifact.id]?.body).toBe('Current');
    });
});
