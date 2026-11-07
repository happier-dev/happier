import * as React from 'react';
import * as ReactNative from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
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
    return createModalModuleMock({ renderCustomModals: true, confirmResult: true }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { Modal, ModalProvider } from '@/modal';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ProseDiffViewer } from '@/components/ui/code/diff/prose/ProseDiffViewer';
import { sync } from '@/sync/sync';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';
import { ArtifactEditProposal } from './ArtifactEditProposal';
import { createArtifactActionsClient } from './artifactActionsClient';
import { setActiveServer, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { DocEditProposalV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const initialState = getStorage().getState();
const artifact: DecryptedArtifact = { id: 'document', title: 'Notes', isDecrypted: true,
    header: { title: 'Notes' }, rawHeader: { title: 'Notes' }, headerVersion: 3, bodyVersion: 3, seq: 3,
    body: 'Current notes', createdAt: 1, updatedAt: 3, ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
const storedHead = { ...artifact, header: encodePlainArtifactStoredContent({ title: 'Notes' }),
    body: encodePlainArtifactStoredContent({ body: 'Current notes' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, encryptionMode: 'plain' };
const revisions = { retentionCount: 10, revisions: [3, 2, 1].map(bodyVersion => ({ bodyVersion,
    body: encodePlainArtifactStoredContent({ body: `Notes ${bodyVersion}` }), createdAt: bodyVersion, sizeBytes: 20 })) };
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
    await act(async () => {
        Modal.hideAll();
        await disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialState, true);
    });
    vi.restoreAllMocks();
    navigation.push.mockClear();
});

async function setup(route: Parameters<typeof serveActionHomes>[0]['route'], settings?: Readonly<Record<string, unknown>>, initialWidth = 900,
    compareFromBodyVersion?: number) {
    const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://history.test', accountId: 'owner', currentAccount: true, settings }],
        route: request => route(request) ?? (request.path === '/v1/artifacts/document' ? Response.json(storedHead) : undefined) });
    disposeHome = served.dispose;
    await served.restoreActiveConnection();
    getStorage().getState().addArtifact(artifact);
    let width = initialWidth;
    vi.spyOn(ReactNative, 'useWindowDimensions').mockImplementation(() => ({ width, height: 900, scale: 1, fontScale: 1 }));
    let commits = 0;
    const content = () => <React.Profiler id="history" onRender={() => { commits++; }}><ModalProvider>{null}</ModalProvider></React.Profiler>;
    const screen = await renderScreen(content());
    await act(async () => { showArtifactHistorySheet({ artifactId: artifact.id, name: 'Notes', canRestore: true, compareFromBodyVersion }); });
    await flushHookEffects();
    return { served, screen, commits: () => commits,
        resize: async (nextWidth: number) => { width = nextWidth; await screen.update(content()); },
        textScale: async (scale: number) => { await act(async () => getStorage().setState(state => ({
            localSettings: { ...state.localSettings, uiFontScale: scale },
        }))); } };
}

describe('Artifact History continuity', () => {
    it.each([900, 390])('explains unavailable comparison without reading a foreign Home current Doc (%s)', async width => {
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });
        const served = await serveActionHomes({ homes: [
            { key: 'b', serverUrl: 'https://history-unavailable-b.test', accountId: 'reader-b', currentAccount: true },
            { key: 'a', serverUrl: 'https://history-unavailable-a.test', accountId: 'reader-a', currentAccount: true },
        ], route: request => request.path.endsWith('/revisions') ? Response.json({ retentionCount: 10, revisions: [2, 1].map(bodyVersion => ({
            bodyVersion, body: encodePlainArtifactStoredContent({ body: `B earlier prose ${bodyVersion}` }), createdAt: bodyVersion, sizeBytes: 20,
        })) }) : request.path === '/v1/artifacts/document' ? Response.json(storedHead) : undefined });
        disposeHome = served.dispose;
        await served.restoreActiveConnection();
        getStorage().getState().addArtifact({ ...artifact, title: 'Foreign A title', body: 'Foreign A body' });
        const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        await act(async () => showArtifactHistorySheet({ artifactId: 'document', name: 'B notes', canRestore: false,
            compareFromBodyVersion: 1, client: createArtifactActionsClient({ serverId: served.homes.b!.id, accountId: 'reader-b' }) }));
        await waitForHomeGovernance(() => {
            expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'artifact-history:compare-unavailable')?.props)
                .toMatchObject({ kind: 'unavailable', title: 'artifacts.browser.history.compareUnavailable',
                    reason: 'artifacts.browser.history.compareCurrentUnavailable' });
        });
        expect(screen.findAllByType(ProseDiffViewer)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('B earlier prose 1');
        expect(screen.getTextContent()).not.toContain('Foreign A');
        // The Action's admission and retained-body reader each read B's head. History adds no Doc read.
        const headReads = served.requests.filter(request => request.path === '/v1/artifacts/document');
        expect(headReads.map(request => [request.home, request.accountId])).toEqual([['b', 'reader-b'], ['b', 'reader-b']]);
        if (width === 390) await screen.pressByTestIdAsync('artifact-history:versions');
        await screen.pressByTestIdAsync('artifact-history:version:2');
        expect(screen.getTextContent()).toContain('B earlier prose 2');
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toEqual(headReads);
        expect(served.requests.filter(request => request.path.endsWith('/revisions')).map(request => [request.home, request.accountId]))
            .toEqual([['b', 'reader-b']]);
    });
    it('does not fetch retained binary History from a different active Home', async () => {
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 900, height: 900, scale: 1, fontScale: 1 });
        const reference = { blobId: 'dd983306-d7e5-4ce6-a09c-d33f1a4828a1', mime: 'application/octet-stream', sizeBytes: 1, sha256: 'a'.repeat(64) };
        const served = await serveActionHomes({ homes: [
            { key: 'b', serverUrl: 'https://history-binary-b.test', accountId: 'reader-b', currentAccount: true },
            { key: 'a', serverUrl: 'https://history-binary-a.test', accountId: 'reader-a', currentAccount: true },
        ], route: request => request.path.endsWith('/revisions') ? Response.json({ retentionCount: 10, revisions: [{ bodyVersion: 1,
            body: encodePlainArtifactStoredContent({ body: reference }), createdAt: 1, sizeBytes: 1 }] })
            : request.path === '/v1/artifacts/document' ? Response.json({ ...storedHead, ownerAccountId: `reader-${request.home}`,
                body: encodePlainArtifactStoredContent({ body: reference }) }) : undefined });
        disposeHome = served.dispose;
        await served.restoreActiveConnection();
        const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        await act(async () => showArtifactHistorySheet({ artifactId: 'document', name: 'B file', canRestore: false,
            client: createArtifactActionsClient({ serverId: served.homes.b!.id, accountId: 'reader-b' }) }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('artifact:download')).not.toBeNull());
        await screen.pressByTestIdAsync('artifact:download');
        await vi.waitFor(() => expect(screen.findByTestId('artifact:downloadFailed')).not.toBeNull());
        expect(served.requests.filter(request => request.home === 'a' && request.path.startsWith('/v1/artifacts/document'))).toEqual([]);
        await act(async () => {
            await served.switchAccount('b', 'another-b-account');
            await setActiveServer({ serverId: served.homes.b!.profileId, scope: 'device' });
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            const credentials = await TokenStorage.getCredentialsForServerUrl(served.homes.b!.serverUrl);
            if (!credentials) throw new Error('Expected changed B credentials');
            await restoreConnectionToActiveServer(credentials);
        });
        await screen.pressByTestIdAsync('artifact:download');
        await vi.waitFor(() => expect(screen.findByTestId('artifact:downloadFailed')).not.toBeNull());
        expect(served.requests.filter(request => request.home === 'b' && request.accountId === 'another-b-account'
            && request.path.startsWith('/v1/artifacts/document'))).toEqual([]);
    });
    it.each(['restore', 'approval'] as const)('keeps direct Discussion Compare, current prose and Restore on captured Home B while ambient A changes (%s)', async mode => {
        vi.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 900, height: 900, scale: 1, fontScale: 1 });
        let restored = false;
        const persisted = createArtifactStoreBoundary({ ownerAccountId: () => 'reader-b', encryptionMode: 'plain' });
        const served = await serveActionHomes({ homes: [
            { key: 'b', serverUrl: 'https://history-captured-b.test', accountId: 'reader-b', currentAccount: true,
                settings: mode === 'approval' ? { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                    actions: { 'artifact.revisions.restore': { approvalRequiredSurfaces: ['ui'] } } }) } : undefined },
            { key: 'c', serverUrl: 'https://history-ambient-c.test', accountId: 'reader-c', currentAccount: true },
            { key: 'a', serverUrl: 'https://history-ambient-a.test', accountId: 'reader-a', currentAccount: true },
        ], route: request => {
            if (request.path === '/v1/artifacts/document') return Response.json({ ...storedHead,
                ownerAccountId: `reader-${request.home}`, header: encodePlainArtifactStoredContent({ title: `${request.home.toUpperCase()} notes`, kind: 'markdown' }),
                body: encodePlainArtifactStoredContent({ body: request.home === 'b' ? restored ? 'B original prose' : 'B current prose' : 'Foreign private prose' }),
                headerVersion: restored && request.home === 'b' ? 4 : 3, bodyVersion: restored && request.home === 'b' ? 4 : 3 });
            if (request.path.endsWith('/revisions')) return Response.json({ retentionCount: 10, revisions: [{ bodyVersion: 1,
                body: encodePlainArtifactStoredContent({ body: request.home === 'b' ? 'B original prose' : 'Foreign earlier prose' }), createdAt: 1, sizeBytes: 20 }] });
            if (request.path.endsWith('/restore')) { restored = true; return Response.json({ success: true, headerVersion: 4, bodyVersion: 4 }); }
            if (request.home === 'b') return persisted.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined;
        } });
        disposeHome = served.dispose;
        await served.restoreActiveConnection();
        getStorage().getState().addArtifact({ ...artifact, title: 'Foreign A title', body: 'Foreign A body' });
        const scope = { serverId: served.homes.b!.id, accountId: 'reader-b' };
        const client = createArtifactActionsClient(scope);
        const base = { headerVersion: 1, bodyVersion: 1 };
        const proposal = DocEditProposalV1Schema.parse({ target: { ref: { kind: 'doc', serverId: scope.serverId, artifactId: 'document' },
            revision: base, range: { start: 0, end: 16 }, quote: 'B original prose' }, baseRevision: base,
            before: 'B original prose', after: 'B proposed prose', reason: 'Clarify the source' });
        const screen = await renderScreen(<ModalProvider><ArtifactEditProposal testID="captured-proposal" client={client}
            proposalRef={{ kind: 'discussion', discussion: { serverId: scope.serverId, discussionId: 'thread-b' }, messageId: 'proposal-b' }}
            proposal={proposal} disposition={{ state: 'open' }} viewerAccountId={scope.accountId} resolveAccountLabel={() => null} /></ModalProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-proposal.compare')).not.toBeNull());
        await screen.pressByTestIdAsync('captured-proposal.compare');
        await waitForHomeGovernance(() => {
            expect(served.requests.filter(request => request.path.endsWith('/revisions')).map(request => [request.home, request.accountId]))
                .toEqual([['b', 'reader-b']]);
            expect(screen.findAllByType(ProseDiffViewer).find(node => node.props.testID === 'artifact-history:changes')?.props)
                .toMatchObject({ oldText: 'B original prose', newText: 'B current prose' });
        });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ chrome: expect.objectContaining({ subtitle: 'B notes' }) }));
        expect(screen.getTextContent()).not.toContain('Foreign');
        expect(getActiveServerSnapshot().serverId).toBe(served.homes.a!.id);
        await act(async () => { await setActiveServer({ serverId: served.homes.c!.profileId, scope: 'device' });
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            const credentials = await TokenStorage.getCredentialsForServerUrl(served.homes.c!.serverUrl);
            if (!credentials) throw new Error('Expected C credentials');
            await restoreConnectionToActiveServer(credentials);
            getStorage().getState().addArtifact({ ...artifact, title: 'Foreign C title', body: 'Foreign C body', headerVersion: 90, bodyVersion: 90 }); });
        await flushHookEffects();
        expect(screen.findAllByType(ProseDiffViewer).find(node => node.props.testID === 'artifact-history:changes')?.props)
            .toMatchObject({ oldText: 'B original prose', newText: 'B current prose' });
        expect(served.requests.filter(request => request.path.endsWith('/revisions'))).toHaveLength(1);
        await screen.pressByTestIdAsync('artifact-history:restore');
        await vi.waitFor(() => expect(screen.findByTestId('artifact-history')).toBeNull());
        if (mode === 'restore') {
            expect(served.requests.find(request => request.path.endsWith('/restore'))).toMatchObject({ home: 'b', accountId: 'reader-b',
                path: '/v1/artifacts/document/revisions/1/restore', body: { expectedHeaderVersion: 3, expectedBodyVersion: 3 } });
        } else {
            const approval = persisted.list()[0];
            expect(approval).toBeDefined();
            expect(ApprovalRequestSchema.parse(JSON.parse(persisted.readPlainBody(approval!.id)!))).toMatchObject({
                actionId: 'artifact.revisions.restore', status: 'open', actionArgs: {
                    artifactId: 'document', bodyVersion: 1, expectedRevision: { headerVersion: 3, bodyVersion: 3 },
                } });
            expect(served.requests.some(request => request.path.endsWith('/restore'))).toBe(false);
            expect(navigation.push).toHaveBeenLastCalledWith(`/inbox/approvals/${encodeURIComponent(approval!.id)}?serverId=${encodeURIComponent(scope.serverId)}`);
        }
        expect(getActiveServerSnapshot().serverId).toBe(served.homes.c!.id);
        expect(served.requests.filter(request => request.path.startsWith('/v1/artifacts/document')).every(request => request.home === 'b')).toBe(true);
    });
    it('requests full-page phone chrome and returns from preview to versions without losing its revision data', async () => {
        const { screen, served } = await setup(request => request.path.endsWith('/revisions') ? Response.json(revisions) : undefined, undefined, 390);
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ phonePresentation: 'fullscreen' }),
        }));
        await screen.pressByTestIdAsync('artifact-history:version:1');
        await screen.pressByTestIdAsync('artifact-history:versions');
        expect(screen.findByTestId('artifact-history:preview')).toBeNull();
        expect(screen.findByType(HappierArtifactRevisionList).props.revisions).toHaveLength(2);
        expect(served.requests.filter(request => request.path.endsWith('/revisions'))).toHaveLength(1);
        await screen.pressByTestIdAsync('artifact-history:version:1');
        expect(screen.getTextContent()).toContain('Notes 1');
    });

    it('opened to compare, shows what changed from the reviewed version to the current one, on a phone too', async () => {
        for (const width of [900, 390]) {
            const { screen } = await setup(request => request.path.endsWith('/revisions') ? Response.json(revisions) : undefined, undefined, width, 1);
            expect(screen.findByType(ProseDiffViewer).props).toMatchObject({ oldText: 'Notes 1', newText: 'Notes 3' });
            expect(screen.findAllByType(HappierArtifactRevisionList).map(list => list.props.selectedVersion)).toEqual(width === 900 ? [1] : []);
            await act(async () => { Modal.hideAll(); await disposeHome?.(); disposeHome = undefined; });
        }
    });

    it.each([true, false])('explains when the reviewed version is no longer retained, with other earlier versions: %s', async hasEarlierVersions => {
        const retained = { retentionCount: 2, revisions: revisions.revisions.filter(revision => hasEarlierVersions ? revision.bodyVersion !== 1 : revision.bodyVersion === 3) };
        const { screen } = await setup(request => request.path.endsWith('/revisions') ? Response.json(retained) : undefined, undefined, 900, 1);
        await waitForHomeGovernance(() => expect(screen.findByTestId('artifact-history:loading')).toBeNull());
        expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'artifact-history:compare-unavailable')?.props)
            .toMatchObject({ kind: 'unavailable', reason: 'artifacts.browser.history.compareReviewedUnavailable' });
        expect(screen.findAllByType(ProseDiffViewer)).toHaveLength(0);
        if (hasEarlierVersions) expect(screen.getTextContent()).toContain('Notes 2');
        else expect(screen.findByTestId('artifact-history:preview')).toBeNull();
    });

    it('uses the body measured during initial loading at 200% text size and retains the selected revision', async () => {
        const first = createDeferred<Response>();
        const { screen, textScale } = await setup(request => request.path.endsWith('/revisions') ? first.promise : undefined, undefined, 1440);
        // The native/web layout boundary reports the mounted body before the HTTP read settles.
        await act(async () => screen.findHostByTestId('artifact-history')?.props.onLayout?.({
            nativeEvent: { layout: { x: 0, y: 0, width: 860, height: 700 } },
        }));
        first.resolve(Response.json(revisions));
        await flushHookEffects();
        await screen.pressByTestIdAsync('artifact-history:version:1');
        await textScale(2);
        expect(screen.findByTestId('artifact-history:preview')).not.toBeNull();
        expect(screen.findAllByType(HappierArtifactRevisionList)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('Notes 1');
        expect(screen.findByTestId('artifact-history:restore')).not.toBeNull();
        await textScale(1);
        expect(screen.findByType(HappierArtifactRevisionList).props.selectedVersion).toBe(1);
    });

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
        await vi.waitFor(() => expect(getStorage().getState().artifacts.document).toMatchObject({ bodyVersion: 4, body: 'Notes 1' }));
        console.info('History restore measurement', { redundantReads: redundantRead.mock.calls.length,
            headReads: served.requests.filter(request => request.path === '/v1/artifacts/document').length, commits: commits() - before });
        await vi.waitFor(() => expect(screen.findByTestId('artifact-history')).toBeNull());
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
        }, { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'artifact.revisions.restore': { approvalRequiredSurfaces: ['ui'] } } }) });
        await screen.pressByTestIdAsync('artifact-history:version:1');
        await screen.pressByTestIdAsync('artifact-history:restore');
        await vi.waitFor(() => expect(approvalId).toBeDefined());
        await vi.waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/inbox/approvals/${encodeURIComponent(approvalId!)}?serverId=${encodeURIComponent(served.homes.owner!.id)}`));
        expect(served.requests.some(request => request.path.endsWith('/restore'))).toBe(false);
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(3);
    });

    it('keeps the selected revision available after a restore conflict settles', async () => {
        const { screen } = await setup(request => request.path.endsWith('/revisions') ? Response.json(revisions)
            : request.path.endsWith('/restore') ? Response.json({ success: false, error: 'version-mismatch' }) : undefined);
        await screen.pressByTestIdAsync('artifact-history:version:1');
        await screen.pressByTestIdAsync('artifact-history:restore');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('artifacts.browser.history.restoreFailed'));
        expect(screen.findByTestId('artifact-history:preview')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Notes 1');
        expect(screen.getTextContent()).toContain('artifacts.browser.history.restoreFailed');
        expect(screen.findByType(HappierArtifactRevisionList).props.selectedVersion).toBe(1);
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(3);
    });
});
