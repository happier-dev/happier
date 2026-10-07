import * as React from 'react';
import * as ReactNative from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { HappierArtifactRevisionList } from '@happier-dev/plugin-ui/presentation';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { Modal, ModalProvider } from '@/modal';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { sync } from '@/sync/sync';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';

const initialState = getStorage().getState();
const artifact: DecryptedArtifact = { id: 'document', title: 'Notes', isDecrypted: true,
    header: { title: 'Notes' }, rawHeader: { title: 'Notes' }, headerVersion: 3, bodyVersion: 3, seq: 3,
    body: 'Current notes', createdAt: 1, updatedAt: 3, ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
const storedHead = { ...artifact, header: encodePlainArtifactStoredContent({ title: 'Notes' }),
    body: encodePlainArtifactStoredContent({ body: 'Current notes' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, encryptionMode: 'plain' };
const revisions = { retentionCount: 10, revisions: [3, 2, 1].map(bodyVersion => ({ bodyVersion,
    body: encodePlainArtifactStoredContent({ body: `Notes ${bodyVersion}` }), createdAt: bodyVersion, sizeBytes: 20 })) };
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
    navigation.push.mockClear();
});

async function setup(route: Parameters<typeof serveActionHomes>[0]['route'], beforeOpen?: () => void) {
    const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://history.test', accountId: 'owner' }],
        route: request => route(request) ?? (request.path === '/v1/artifacts/document' ? Response.json(storedHead) : undefined) });
    disposeHome = served.dispose;
    getStorage().getState().addArtifact(artifact);
    beforeOpen?.();
    let width = 900;
    vi.spyOn(ReactNative, 'useWindowDimensions').mockImplementation(() => ({ width, height: 900, scale: 1, fontScale: 1 }));
    let commits = 0;
    const content = () => <React.Profiler id="history" onRender={() => { commits++; }}><ModalProvider>{null}</ModalProvider></React.Profiler>;
    const screen = await renderScreen(content());
    await act(async () => { showArtifactHistorySheet({ artifactId: artifact.id, name: 'Notes', canRestore: true }); });
    await flushHookEffects();
    return { served, screen, commits: () => commits,
        resize: async (nextWidth: number) => { width = nextWidth; await screen.update(content()); } };
}

describe('Artifact History continuity', () => {
    it('keeps an older selection and its data across the breakpoint without another revision read', async () => {
        const { screen, served, resize, commits } = await setup(request => request.path.endsWith('/revisions') ? Response.json(revisions) : undefined);
        // Selecting a historical version must work even if the server includes the current head.
        const defaultPreview = screen.findByTestId('artifact-history:preview') !== null;
        await screen.pressByTestIdAsync('artifact-history:version:1');
        const before = commits();
        const readsBefore = served.requests.filter(request => request.path.endsWith('/revisions')).length;
        await resize(390);
        const narrowPreview = screen.findByTestId('artifact-history:preview') !== null;
        await resize(900);
        const readsAfter = served.requests.filter(request => request.path.endsWith('/revisions')).length;
        console.info('History resize measurement', { readsBefore, readsAfter, commits: commits() - before });
        expect(readsAfter).toBe(readsBefore);
        expect(defaultPreview).toBe(true);
        expect(narrowPreview).toBe(true);
        expect(screen.findByType(HappierArtifactRevisionList).props.selectedVersion).toBe(1);
        expect(screen.getTextContent()).toContain('Notes 1');
    });

    it('shows a canonical initial loading state and retains the selected preview during refresh, failure and retry', async () => {
        const first = createDeferred<Response>();
        let response = first.promise;
        let headVersion = 3;
        const { screen, resize } = await setup(request => request.path.endsWith('/revisions') ? response
            : request.path === '/v1/artifacts/document' ? Response.json({ ...storedHead, headerVersion: headVersion, bodyVersion: headVersion }) : undefined);
        expect(screen.findByType(SurfaceStateCard).props.kind).toBe('loading');
        first.resolve(Response.json(revisions));
        await flushHookEffects();
        await screen.pressByTestIdAsync('artifact-history:version:1');
        const refresh = createDeferred<Response>();
        response = refresh.promise;
        headVersion = 4;
        await act(async () => { getStorage().getState().updateArtifact({ ...artifact, headerVersion: 4, bodyVersion: 4 }); });
        await flushHookEffects();
        expect(screen.findByTestId('artifact-history:preview')).not.toBeNull();
        expect(screen.findByTestId('artifact-history:refreshing')).not.toBeNull();
        refresh.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
        await flushHookEffects();
        expect(screen.findByTestId('artifact-history:preview')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Notes 1');
        expect(screen.findByTestId('artifact-history:stale')).not.toBeNull();
        response = Promise.resolve(Response.json(revisions));
        await screen.pressByTestIdAsync('artifact-history:stale-action');
        await flushHookEffects();
        await resize(900);
        expect(screen.findByType(HappierArtifactRevisionList).props.selectedVersion).toBe(1);
        expect(screen.findByTestId('artifact-history:stale')).toBeNull();
    });

    it('uses the restore acknowledgement already published by the Account Action owner without a second head fetch', async () => {
        await loadSyncSingletonForTests();
        const redundantRead = vi.spyOn(sync, 'fetchArtifactWithBody'); // Measurement only: the implementation runs unchanged.
        let restored = false;
        const { screen, served, commits } = await setup(request => {
            if (request.path.endsWith('/revisions')) return Response.json(revisions);
            if (request.path.endsWith('/restore')) {
                restored = true;
                return Response.json({ success: true, headerVersion: 4, bodyVersion: 4 });
            }
            if (request.path === '/v1/artifacts/document' && restored) return Response.json({ ...storedHead,
                body: encodePlainArtifactStoredContent({ body: 'Notes 1' }), headerVersion: 4, bodyVersion: 4 });
        });
        await screen.pressByTestIdAsync('artifact-history:version:1');
        const before = commits();
        await screen.pressByTestIdAsync('artifact-history:restore');
        await flushHookEffects();
        console.info('History restore measurement', { redundantReads: redundantRead.mock.calls.length,
            headReads: served.requests.filter(request => request.path === '/v1/artifacts/document').length, commits: commits() - before });
        expect(getStorage().getState().artifacts.document).toMatchObject({ bodyVersion: 4, body: 'Notes 1' });
        expect(screen.findByTestId('artifact-history')).toBeNull();
        expect(redundantRead).not.toHaveBeenCalled();
    });

    it('opens the durable approval destination when Restore requires approval, retaining the current head', async () => {
        let approvalId: string | undefined;
        const { screen, served } = await setup(request => {
            if (request.path.endsWith('/revisions')) return Response.json(revisions);
            if (request.path === '/v1/artifacts' && request.method === 'POST' && request.body && typeof request.body === 'object') {
                const input = request.body as Record<string, unknown>;
                approvalId = String(input.id);
                return Response.json({ ...storedHead, ...input, headerVersion: 1, bodyVersion: 1 });
            }
        }, () => {
            const state = getStorage().getState();
            getStorage().setState({ settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { 'artifact.revisions.restore': { approvalRequiredSurfaces: ['ui'] } } }) } });
        });
        await screen.pressByTestIdAsync('artifact-history:version:1');
        await screen.pressByTestIdAsync('artifact-history:restore');
        await flushHookEffects();
        expect(approvalId).toBeDefined();
        expect(navigation.push).toHaveBeenCalledWith(`/inbox/approvals/${encodeURIComponent(approvalId!)}?serverId=${encodeURIComponent(served.homes.owner!.id)}`);
        expect(served.requests.some(request => request.path.endsWith('/restore'))).toBe(false);
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(3);
    });

    it('keeps the selected revision available after a restore conflict settles', async () => {
        const { screen } = await setup(request => request.path.endsWith('/revisions') ? Response.json(revisions)
            : request.path.endsWith('/restore') ? Response.json({ success: false, error: 'version-mismatch' }) : undefined);
        await screen.pressByTestIdAsync('artifact-history:version:1');
        await screen.pressByTestIdAsync('artifact-history:restore');
        await flushHookEffects();
        expect(screen.findByTestId('artifact-history:preview')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Notes 1');
        expect(screen.getTextContent()).toContain('artifacts.browser.history.restoreFailed');
        expect(screen.findByType(HappierArtifactRevisionList).props.selectedVersion).toBe(1);
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(3);
    });
});
