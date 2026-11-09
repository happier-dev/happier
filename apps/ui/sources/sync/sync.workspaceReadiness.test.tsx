import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { WorkspaceTab } from '@/components/appShell/workspace/workspaceState';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const initialNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
await initialNetwork.dispose();

describe('Sync workspace readiness', () => {
    beforeEach(() => vi.resetModules());
    it('recovers an offscreen Session draft without materializing the owning Session', async () => {
        const network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://draft-context.example.test', 'draft-context-account');
        const scope = { serverId: home.id, accountId: home.accountId };
        const address = { kind: 'session', sessionId: 'offscreen-draft' } as const;
        const { createSessionDraftRepository } = await import('./ops/sessionDrafts/sessionDraftRepository');
        const { createSessionDraftCipher } = await import('./encryption/sessionDraftEncryption');
        const { requireComposerDraftDocument } = await import('@/dev/testkit');
        const values = new Map<string, string>();
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => ({ mode: 'plain' }), randomBytes: length => new Uint8Array(length) });
        const author = createSessionDraftRepository({ scope, cipher, syncEnabled: false, storage: {
            getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => { values.set(key, value); }, delete: key => { values.delete(key); },
        } });
        author.writeExistingSessionDraft({ scope, sessionId: address.sessionId, patch: { text: 'Recovered draft' } });
        const document = author.getSessionDraftSnapshot(scope, address)!.document;
        const record = { address, revision: 1, createdAt: 1, updatedAt: 1, content: await cipher.seal(address, document) };
        const { profileDefaults } = await import('./domains/profiles/profile');
        let exactReads = 0;
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, drafts: { enabled: true } } } }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v2/account/session-drafts/list') return Response.json({ items: [record] });
            if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'present', record });
            const sessionRoute = /^\/v2\/sessions\/([^/]+)$/.exec(path);
            if (sessionRoute && sessionRoute[1] !== 'active') return Response.json({
                session: createPlainSessionCurrentProjectionRecordFixture({ id: decodeURIComponent(sessionRoute[1]!) }) });
            const turnsRoute = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
            if (turnsRoute) return Response.json({ v: 1, sessionId: decodeURIComponent(turnsRoute[1]!), updatedAt: 1, turns: [] });
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/feed') return Response.json({ items: [], hasMore: false });
            if (path === '/v1/kv') return Response.json({ items: [] });
            return null;
        });
        // Draft pages read their Sessions' encryption contexts as one finite batch; the harness
        // answers each batch through the per-Session routes above, so count the batch itself.
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const answerBatchesThroughResponder = network.request;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v2/sessions/read-batch' && init?.method === 'POST'
                && (JSON.parse(String(init.body)).sessionIds as string[]).includes(address.sessionId)) exactReads += 1;
            return answerBatchesThroughResponder(input, init);
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
        const { storage } = await import('./domains/state/storage');
        const { syncSwitchServer } = await import('./sync');
        const { getSessionDraftSnapshot, materializeExactSessionDraft } = await import('./ops/sessionDrafts/sessionDraftRepository');
        await syncSwitchServer(null);
        try {
            await upsertAndActivateServer({ serverUrl: home.serverUrl });
            await restoreConnectionToActiveServer({ token: home.token });
            await vi.waitFor(() => expect(storage.getState().isSessionDraftsReady).toBe(true), { timeout: 30_000 });
            expect(requireComposerDraftDocument(getSessionDraftSnapshot(scope, address)?.document)?.composer.text.value).toBe('Recovered draft');
            expect(exactReads).toBe(1);
            expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
            storage.getState().applyServerScopedSessionListRows(home.id, [createSessionListRenderableSessionFixture({
                id: address.sessionId, encryptionMode: 'plain',
            })], { source: 'ordinary', mode: 'append' });
            storage.setState(state => ({ settings: { ...state.settings, clientEncryptionRequirementV1: 'require_e2ee' } }));
            await expect(materializeExactSessionDraft(scope, address)).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
        } finally {
            await disconnectActiveServerConnection();
            await network.dispose();
            vi.restoreAllMocks();
        }
    }, 120_000);
    it.each([
        [false, false, false, false],
        [true, false, false, false],
        [false, true, false, false],
        [false, false, true, false],
        [false, false, false, true],
    ])('publishes Account readiness before peripheral hydration (superseding Home=%s, transient failure=%s, settings failure=%s, pending Sessions=%s)', async (supersede, failSessions, failSettings, holdSessions = false) => {
        const network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://bootstrap-ready.example.test', 'bootstrap-account');
        const nextHome = await network.addHome('https://bootstrap-next.example.test', 'next-account');
        const oldProfile = createDeferred<void>();
        const profileStarted = createDeferred<void>();
        const peripheral = createDeferred<void>();
        const peripheralStarted = createDeferred<void>();
        const retry = createDeferred<void>();
        const sessionSnapshot = createDeferred<void>();
        const { profileDefaults } = await import('./domains/profiles/profile');
        let peripheralSettled = false;
        let sessionsRead = false;
        let nextProfileRead = false;
        let failedSessions = false;
        let failedSettings = false;
        let retrySettled = false;
        const pendingSnapshotPaths = new Set<string>();
        let snapshotBurst = 0;
        network.setHttpResponder(async input => {
            const url = new URL(String(input));
            const path = url.pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') {
                if (failSettings) {
                    if (!failedSettings) {
                        failedSettings = true;
                        return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
                    }
                    await retry.promise;
                    retrySettled = true;
                }
                return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            }
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v1/account/profile') {
                if (supersede && url.origin === home.serverUrl) { profileStarted.resolve(); await oldProfile.promise; }
                // A failed core attempt must expose the shell/error even if a
                // sibling core read has not returned yet.
                if (failSettings) await retry.promise;
                if (url.origin === nextHome.serverUrl) nextProfileRead = true;
                return Response.json({ ...profileDefaults, id: url.origin === home.serverUrl ? home.accountId : nextHome.accountId });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            if (path === '/v2/sessions' || path === '/v2/sessions/active') {
                sessionsRead = true;
                if (holdSessions) await sessionSnapshot.promise;
                if (failSessions) {
                    if (!failedSessions) {
                        failedSessions = true;
                        return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
                    }
                    await retry.promise;
                    retrySettled = true;
                }
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (path === '/v2/sessions/opened') {
                return Response.json({ session: {
                    ...createPlainSessionCurrentProjectionRecordFixture({ id: 'opened' }),
                    viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: 'opened' })),
                } });
            }
            if (['/v1/machines', '/v1/kv', '/v1/feed'].includes(path)) {
                pendingSnapshotPaths.add(path);
                snapshotBurst = Math.max(snapshotBurst, pendingSnapshotPaths.size);
                peripheralStarted.resolve();
                await peripheral.promise;
                peripheralSettled = true;
                pendingSnapshotPaths.delete(path);
                if (path === '/v1/kv') return Response.json({ items: [] });
                if (path === '/v1/feed') return Response.json({ items: [], hasMore: false });
                return Response.json([]);
            }
            return null;
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const { restoreConnectionToActiveServer, switchConnectionToActiveServer, disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
        const { storage } = await import('./domains/state/storage');
        const { syncSwitchServer } = await import('./sync');
        await syncSwitchServer(null);
        const archiveOperation = supersede ? storage.getState().beginSessionArchive({
            serverId: home.id, sessionId: 'archive-during-real-home-switch',
        }) : null;
        let readyAt: number | null = null;
        let readyBeforePeripheral = false;
        let readyProfileId: string | null = null;
        let readyError: ReturnType<typeof storage.getState>['syncError'] = null;
        let sawRetryableError = false;
        const start = performance.now();
        const unsubscribe = storage.subscribe(state => {
            if (state.syncError?.retryable) sawRetryableError = true;
            if (!state.isDataReady || readyAt !== null) return;
            readyAt = performance.now() - start;
            readyBeforePeripheral = !peripheralSettled;
            readyProfileId = state.profile.id;
            readyError = state.syncError;
        });
        // Network latency is a fixture, not a new product deadline. The real
        // Sync owner, queues, admission limiter and state publication run intact.
        let release: ReturnType<typeof setTimeout> | undefined = supersede ? undefined : setTimeout(() => peripheral.resolve(), 1500);
        try {
            await upsertAndActivateServer({ serverUrl: home.serverUrl });
            const firstRestore = restoreConnectionToActiveServer({ token: home.token });
            if (supersede) {
                await profileStarted.promise;
                await firstRestore;
                expect(storage.getState().isDataReady).toBe(false);
                await upsertAndActivateServer({ serverUrl: nextHome.serverUrl });
                const secondRestore = switchConnectionToActiveServer();
                release = setTimeout(() => peripheral.resolve(), 1500);
                oldProfile.resolve();
                await secondRestore;
                expect(storage.getState().sessionArchiveOperations[home.id]?.[archiveOperation!.sessionId]).toBe(archiveOperation);
                expect(storage.getState().beginSessionArchive({ serverId: home.id, sessionId: archiveOperation!.sessionId })).toBeNull();
            } else await firstRestore;
            await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true), { timeout: holdSessions ? 2000 : 30_000 });
            if (holdSessions) {
                // The retained workspace must admit its own routes while the
                // unrelated Account inventory is still awaiting HTTP.
                const { useWorkspaceState } = await import('@/components/appShell/workspace/useWorkspaceState');
                const { useHydrateSessionForRoute } = await import('@/hooks/session/useHydrateSessionForRoute');
                const workspace = await renderHook(() => ({
                    workspace: useWorkspaceState({
                        initialTab: { id: 'opened', target: { kind: 'session', params: { id: 'opened', serverId: home.id } }, pinned: false, preview: true },
                        windowId: 'pending-inventory',
                    }),
                    route: useHydrateSessionForRoute('opened', 'FX88', { serverId: home.id, hydrateMessages: false }),
                }));
                expect(workspace.getCurrent().workspace.isReady).toBe(true);
                await vi.waitFor(() => expect(workspace.getCurrent().route.kind).toBe('available'));
                expect(storage.getState().sessions.opened).toMatchObject({ id: 'opened', serverId: home.id, encryptionMode: 'plain' });
                await workspace.unmount();
            }
            console.info(`bootstrap-readiness supersede=${supersede} readyMs=${Math.round(readyAt!)} beforePeripheral=${readyBeforePeripheral} snapshotBurst=${snapshotBurst}`);
            expect(sessionsRead).toBe(!failSettings);
            if (supersede) {
                expect(nextProfileRead).toBe(true);
                expect(readyProfileId).toBe(nextHome.accountId);
                expect(storage.getState().profile.id).toBe(nextHome.accountId);
                expect(storage.getState().profileScope?.accountId).toBe(nextHome.accountId);
            }
            expect(readyBeforePeripheral).toBe(true);
            if (failSessions || failSettings) {
                if (failSettings) expect(readyError).toMatchObject({ retryable: true });
                else await vi.waitFor(() => expect(sawRetryableError).toBe(true));
                expect(retrySettled).toBe(false);
            }
            if (failSettings) {
                retry.resolve();
                await vi.waitFor(() => expect(sessionsRead).toBe(true));
            }
            await peripheralStarted.promise;
            if (!supersede && !failSessions && !failSettings) {
                await vi.waitFor(() => expect(snapshotBurst).toBe(3));
            }
        } finally {
            clearTimeout(release);
            sessionSnapshot.resolve();
            peripheral.resolve();
            retry.resolve();
            oldProfile.resolve();
            unsubscribe();
            if (archiveOperation) storage.getState().finishSessionArchive(archiveOperation);
            await disconnectActiveServerConnection();
            await network.dispose();
            vi.restoreAllMocks();
        }
    }, 120_000);
    it.each(['recover', 'retire'] as const)('restores retained workspace content before draft hydration, then %s the captured outbox scope', async (completion) => {
        const network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://ready-home.example.test', 'ready-account');
        const inactiveHome = await network.addHome('https://inactive-ready-home.example.test', 'inactive-ready-account');
        const drafts = createDeferred<void>();
        const draftRead = createDeferred<void>();
        const pendingRead = createDeferred<void>();
        const exactRead = createDeferred<void>();
        const exactDraft = createDeferred<void>();
        const inactiveRead = createDeferred<void>();
        const inactiveDraft = createDeferred<void>();
        const observedPaths = new Set<string>();
        let pendingReads = 0;
        let draftsSettled = false;
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            observedPaths.add(path);
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: { sessions: { drafts: { enabled: true } } } }));
            if (path === '/v2/account/session-drafts/list') { draftRead.resolve(); await drafts.promise; draftsSettled = true; return Response.json({ items: [] }); }
            if (path === '/v2/account/session-drafts/read') {
                if (new URL(String(input)).origin === inactiveHome.serverUrl) {
                    inactiveRead.resolve();
                    await inactiveDraft.promise;
                    return Response.json({ status: 'absent' });
                }
                exactRead.resolve();
                await exactDraft.promise;
                return Response.json({ status: 'absent' });
            }
            if (path === '/v2/sessions/retained-outbox/pending') {
                expect(draftsSettled).toBe(true);
                pendingReads += 1;
                pendingRead.resolve();
                return Response.json({ pending: [] });
            }
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/feed') return Response.json({ items: [], hasMore: false });
            if (path === '/v1/kv') return Response.json({ items: [] });
            return null;
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
        const { storage } = await import('./domains/state/storage');
        const { sync, syncSwitchServer } = await import('./sync');
        // Retire both transport authority and the public initialization latch.
        await syncSwitchServer(null);
        const { savePendingOutboxMessage, loadPendingOutboxForSession } = await import('./domains/state/pendingOutboxPersistence');
        const { useWorkspaceState } = await import('@/components/appShell/workspace/useWorkspaceState');
        const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { workspaceLayoutScopeKey } = await import('@/components/appShell/workspace/workspacePersistence');
        const tab = { id: 'retained', target: { kind: 'settings', params: {} }, pinned: true, preview: false } satisfies WorkspaceTab;
        const scope = { serverId: home.id, accountId: home.accountId };
        const { workspaceLayoutsState } = await import('./domains/state/filePaneUiState');
        workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...scope, windowId: 'ready-window' }), createWorkspaceState(tab));
        storage.setState({ isDataReady: false, isSessionDraftsReady: false });
        await savePendingOutboxMessage({ sessionId: 'retained-outbox', localId: 'retained-input', createdAt: 1,
            text: 'Retained input', rawRecord: { role: 'user' }, request: { v: 1,
                body: JSON.stringify({ localId: 'retained-input', content: { t: 'plain', v: { role: 'user' } }, messageRole: 'user' }) } }, scope);
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useWorkspaceState>>>> | undefined;
        let editor: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let inactiveEditor: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let bindings: Awaited<ReturnType<typeof renderHook<ReturnType<typeof import('./domains/scope/useServerCredentialAccountScopes')['useServerCredentialAccountScopeBindings']>>>> | undefined;
        try {
            await upsertAndActivateServer({ serverUrl: home.serverUrl });
            await restoreConnectionToActiveServer({ token: home.token });
            await vi.waitFor(() => {
                expect({ coreReady: storage.getState().isDataReady, paths: [...observedPaths] }).toMatchObject({ coreReady: true });
            }, { timeout: 30_000 });
            expect({ draftReady: storage.getState().isSessionDraftsReady, paths: [...observedPaths] }).toMatchObject({ draftReady: false });
            await draftRead.promise;
            await vi.waitFor(() => expect(observedPaths.has('/v1/feed')).toBe(true));
            expect(storage.getState().isDataReady).toBe(true);
            expect(storage.getState().isSessionDraftsReady).toBe(false);
            expect(pendingReads).toBe(0);
            hook = await renderHook(() => useWorkspaceState({ initialTab: { ...tab, id: 'fallback' }, windowId: 'ready-window' }));
            expect(hook.getCurrent().isReady).toBe(true);
            expect(hook.getCurrent().state.tabs.retained).toEqual(tab);
            const { SessionDraftHydrationBoundary } = await import('@/components/sessions/drafts/SessionDraftHydrationBoundary');
            const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
            const { ItemLoadStateRows } = await import('@/components/ui/lists/ItemLoadStateRows');
            editor = await renderScreen(React.createElement(SessionDraftHydrationBoundary, {
                addresses: [{ kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000903' }],
                children: React.createElement('EditableDraftProbe'),
                ...{ fallback: React.createElement(GlassSurface, {
                    testID: 'new-session-draft-loading', finishRole: 'composer',
                    children: React.createElement(ItemLoadStateRows, { state: { kind: 'loading' }, rows: 2, lines: 1 }),
                }) },
            }));
            await vi.waitFor(() => expect(observedPaths.has('/v2/account/session-drafts/read')).toBe(true));
            await exactRead.promise;
            expect(editor.root.findAllByType('EditableDraftProbe')).toHaveLength(0);
            expect(editor.findByTestId('new-session-draft-loading')).not.toBeNull();
            expect(editor.findByTestId('session-drafts-hydrating')).toBeNull();
            if (completion === 'retire') {
                // Join the real repository's shared hydration, then retire its
                // Account lifetime before that HTTP response arrives.
                const hydration = (sync as unknown as { refreshSessionDraftRepositoryForSync(): Promise<void> }).refreshSessionDraftRepositoryForSync();
                await act(async () => { await disconnectActiveServerConnection(); });
                exactDraft.resolve();
                drafts.resolve();
                await hydration;
                expect(storage.getState().isDataReady).toBe(false);
                expect(storage.getState().isSessionDraftsReady).toBe(false);
                expect(pendingReads).toBe(0);
                expect(editor.root.findAllByType('EditableDraftProbe')).toHaveLength(0);
            } else {
                const { captureActiveServerAccountScopeLifetime } = await import('./domains/scope/activeServerAccountScope');
                const lifetime = captureActiveServerAccountScopeLifetime();
                expect(lifetime?.isCurrent()).toBe(true);
                let visibleSessionReady = false;
                const visibleSessionDraft = sync.materializeExistingSessionDraft('retained-outbox', lifetime!).then(() => {
                    visibleSessionReady = true;
                });
                await act(async () => {
                    exactDraft.resolve();
                    await sync.prepareSessionDraftSurface(lifetime!, [{ kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000903' }]);
                });
                await vi.waitFor(() => expect(editor!.root.findAllByType('EditableDraftProbe')).toHaveLength(1));
                await vi.waitFor(() => expect(visibleSessionReady).toBe(true));
                await visibleSessionDraft;
                expect(storage.getState().isSessionDraftsReady).toBe(false);
                expect(pendingReads).toBe(0);
                const { useServerCredentialAccountScopeBindings } = await import('./domains/scope/useServerCredentialAccountScopes');
                bindings = await renderHook(() => useServerCredentialAccountScopeBindings([inactiveHome.id]));
                await vi.waitFor(() => expect(bindings!.getCurrent().get(inactiveHome.id)?.isCurrent()).toBe(true));
                const inactiveLifetime = bindings.getCurrent().get(inactiveHome.id)!;
                inactiveEditor = await renderScreen(React.createElement(SessionDraftHydrationBoundary, {
                    lifetime: inactiveLifetime,
                    addresses: [{ kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000903' }],
                    children: React.createElement('InactiveEditableDraftProbe'),
                }));
                await vi.waitFor(() => expect(network.httpRequests.some(row => row.url === `${inactiveHome.serverUrl}/v2/account/session-drafts/read`)).toBe(true));
                await inactiveRead.promise;
                drafts.resolve();
                await pendingRead.promise;
                expect(storage.getState().isSessionDraftsReady).toBe(true);
                expect(inactiveEditor.root.findAllByType('InactiveEditableDraftProbe')).toHaveLength(0);
                await act(async () => {
                    inactiveDraft.resolve();
                    await sync.prepareSessionDraftSurface(inactiveLifetime, [{ kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000903' }]);
                });
                await vi.waitFor(() => expect(inactiveEditor!.root.findAllByType('InactiveEditableDraftProbe')).toHaveLength(1));
                expect(network.httpRequests.some(row => row.url === `${inactiveHome.serverUrl}/v2/account/session-drafts/list`)).toBe(false);
                expect(storage.getState().sessionPending['retained-outbox']?.messages.map(row => row.localId)).toContain('retained-input');
                let emptyPublications = 0;
                const stopObserving = storage.subscribe((next, previous) => {
                    if (Object.keys(next).every(key => Object.is(next[key as keyof typeof next], previous[key as keyof typeof previous]))) {
                        emptyPublications += 1;
                    }
                });
                try {
                    await (sync as unknown as { refreshSessionDraftRepositoryForSync(): Promise<void> }).refreshSessionDraftRepositoryForSync();
                    expect(storage.getState().isSessionDraftsReady).toBe(true);
                    expect(emptyPublications).toBe(0);
                } finally { stopObserving(); }
            }
            expect((await loadPendingOutboxForSession('retained-outbox', scope)).map(row => row.localId)).toContain('retained-input');
        } finally {
            exactDraft.resolve();
            inactiveDraft.resolve();
            drafts.resolve();
            await act(async () => { await disconnectActiveServerConnection(); });
            await hook?.unmount();
            await editor?.unmount();
            await inactiveEditor?.unmount();
            await bindings?.unmount();
            await network.dispose();
            vi.restoreAllMocks();
        }
    }, 120_000);
});
