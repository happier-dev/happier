import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createSessionFixture } = await import('@/dev/testkit');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { resetSessionDraftRepositoryForTests, writeExistingSessionDraft, getSessionDraftSnapshot, listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { createRepositoryComposerDocumentOwner } = await import('@/components/sessions/composer/repositoryComposerDocumentOwner');
const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { appendMountedComposerDraft } = await import('./appendMountedComposerDraft');

let scope: { serverId: string; accountId: string };
let unmount: (() => void) | undefined;
beforeEach(async () => {
    await home.reset();
    resetSessionDraftRepositoryForTests();
    await prepareSessionDraftPersistenceStorage();
    const serverId = await home.addHome({ serverUrl: 'https://append.test', name: 'Append', accountId: 'account-a' });
    home.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://append.test');
    if (!credentials) throw new Error('Expected signed-in Home');
    await restoreConnectionToActiveServer(credentials);
    scope = { serverId, accountId: 'account-a' };
    getStorage().setState({ profileScope: scope, sessions: { 'source-session': createSessionFixture({ id: 'source-session', serverId }) } });
});
afterEach(async () => { unmount?.(); unmount = undefined; await disconnectActiveServerConnection(); vi.unstubAllGlobals(); });

function mountComposer(text: string, editable = true) {
    const ref = { kind: 'session' as const, sessionId: 'source-session' };
    writeExistingSessionDraft({ scope, sessionId: ref.sessionId, patch: { text } });
    const owner = createRepositoryComposerDocumentOwner({ scope, ref });
    const focus = vi.fn(() => true);
    unmount = registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId: ref.sessionId }, {
        readScope: () => scope,
        readRevision: () => owner.read().revision,
        replace: (nextText) => owner.replaceDocument({ ...owner.read().document, text: nextText }),
        readSnapshot: () => projectComposerDocumentSnapshot({ owner, attachmentCatalog: { entriesById: null }, presentation: {
            layout: 'wrap', focused: false, editable, submittable: editable, submitting: false, running: false,
        } }),
        commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
        commitDocumentEmitsChange: true,
        focusComposer: focus,
    });
    return { ref, owner, focus };
}

describe('appendMountedComposerDraft', () => {
    it('preserves unsent text, appends again from the current revision, and focuses without sending', async () => {
        const { ref, owner, focus } = mountComposer('Keep my unsent text');
        expect(await appendMountedComposerDraft({ scope, ref, text: 'First request' })).toBe(true);
        expect(owner.read().document.text).toBe('Keep my unsent text\nFirst request');
        owner.replaceDocument({ ...owner.read().document, text: `${owner.read().document.text}\nEdited meanwhile` });
        expect(await appendMountedComposerDraft({ scope, ref, text: 'Second request' })).toBe(true);
        const expected = 'Keep my unsent text\nFirst request\nEdited meanwhile\nSecond request';
        expect(owner.read().document.text).toBe(expected);
        expect(getSessionDraftSnapshot(scope, ref)?.document).toMatchObject({ composer: { text: { value: expected } } });
        expect(focus).toHaveBeenCalled();
        expect(listNewSessionDraftProjections(scope)).toHaveLength(0);
        expect(Object.keys(getStorage().getState().sessions)).toEqual(['source-session']);
        expect(home.requests.some((request) => request.path.includes('/sessions') && request.input != null)).toBe(false);
    });

    it.each(['revision', 'home', 'readOnly'] as const)('preserves current text and focus when the %s changes before ingress applies', async (condition) => {
        const { ref, owner, focus } = mountComposer('Keep me', condition !== 'readOnly');
        const pending = appendMountedComposerDraft({ scope, ref, text: 'Must not overwrite' });
        if (condition === 'revision') owner.replaceDocument({ ...owner.read().document, text: 'Keep me\nTyped meanwhile' });
        if (condition === 'home') getStorage().setState({ profileScope: { ...scope, accountId: 'other-account' } });
        expect(await pending).toBe(false);
        expect(owner.read().document.text).toBe(condition === 'revision' ? 'Keep me\nTyped meanwhile' : 'Keep me');
        expect(focus).not.toHaveBeenCalled();
        expect(listNewSessionDraftProjections(scope)).toHaveLength(0);
        expect(home.requests.some((request) => request.path.includes('/sessions') && request.input != null)).toBe(false);
    });
});
