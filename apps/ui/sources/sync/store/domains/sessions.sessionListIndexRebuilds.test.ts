import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { MMKV } from 'react-native-mmkv';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { captureSessionFullPublicationBaseline } from '@/sync/domains/session/sessionRuntimeObservation';
import type { StorageState } from '@/sync/store/types';
import { createSessionsDomain } from './sessions';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import * as reachableTargets from '@/sync/domains/session/resolveSessionReachableMachineId';
import * as warmCachePersistence from '@/sync/domains/state/warmCachePersistence';
import * as warmCacheAdaptersModule from '@/sync/domains/state/warmCacheAdapters';
import { SESSION_LIST_WARM_CACHE_MAX_ENTRIES } from '@/sync/domains/state/warmCacheAdapters';
import { saveWarmSessionCacheForState } from './sessionListIndexFinalization';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile, resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { readSessionListRowForServerId, readSessionListRowsForServerId } from '../../domains/session/listing/sessionListRowStateLookup';
import { buildSessionListIndexFromViewData } from '../../domains/sessionList/sessionListIndex';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { getSessionStorageKind } from '../../domains/session/sessionStorageKind';
import { readExternalSessionLink } from '../../domains/session/external/readExternalSessionLink';
import type { ScmStatus, ScmWorkingSnapshot, Session } from '../../domains/state/storageTypes';
import { createDemoOpenCodeSessionFixture } from '@/demoMode/world/sessions';

vi.mock('socket.io-client', async (importOriginal) => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));

// The composed alias-convergence case uses real Sync. Compile its graph during
// collection rather than spending the response-ordering test's budget importing it.
const syncModule = await import('@/sync/sync');

beforeAll(async () => { await warmCachePersistence.prepareWarmCacheStorage(); });

const harnessCleanup: Array<() => void> = [];
beforeEach(async () => {
    vi.restoreAllMocks();
    warmCacheWrites.mockClear();
    projectManager.clear();
    await activateTestHome('srv_active');
});
afterEach(() => {
    for (const cleanup of harnessCleanup.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
});

const warmCacheWrites = vi.fn<(key: string, bytes: string, entries: Record<string, unknown>) => void>();

function observeSessionListWarmCacheWrites(): void {
    warmCachePersistence.clearWarmCacheAccountScope();
    warmCachePersistence.saveSessionListWarmCacheEntries(getActiveServerSnapshot().serverId, 'account_a', {});
    const write = MMKV.prototype.set;
    vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: MMKV, key, value) {
        if (key.startsWith('session-list-warm-cache-v1:') && typeof value === 'string') {
            warmCacheWrites(key, value, JSON.parse(value));
        }
        return write.call(this, key, value);
    });
}

async function activateTestHome(serverId: string, serverUrl = 'https://' + serverId + '.test') {
    const profile = await upsertServerProfile({ serverUrl });
    if (serverId.startsWith('srv_')) await setServerProfileIdentityForUrl(serverUrl, serverId);
    await setActiveServerId(profile.id, { scope: 'device' });
    return profile;
}

function currentSession(overrides: Parameters<typeof createSessionFixture>[0]) {
    return createSessionFixture({
        serverId: getActiveServerSnapshot().serverId,
        meaningfulActivityAt: overrides?.createdAt ?? 1,
        ...overrides,
    });
}

function createHarness(initialState?: Record<string, unknown>) {
    const initial = storage.getInitialState();
    const store = createStore<StorageState>()((set, get) => ({
        ...initial,
        ...createSessionsDomain<StorageState>({ set, get }),
        machines: {}, machineDisplayById: {}, sessionMessages: {}, sessionMessagesHistoryStartLoaded: {},
        profile: { ...initial.profile, id: 'account_a' },
        ...initialState,
        settings: { ...initial.settings, ...(initialState?.settings && typeof initialState.settings === 'object' ? initialState.settings : {}) },
    }));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    const domain = store.getState();
    harnessCleanup.push(() => { unsubscribe(); domain.clearSessionLocalStateScope(); });
    return { get: store.getState, domain, set: store.setState, getSetCalls: () => notifications };
}

/** A list response publishes ordinary membership separately from detail hydration. */
function applyOrdinarySnapshot(domain: StorageState, sessions: Parameters<StorageState['applySessions']>[0]): void {
    domain.applySessions(sessions);
    const rowsByHome = new Map<string, SessionListRenderableSession[]>();
    for (const session of sessions) {
        const serverId = resolveServerProfileScopeIdForIdentifier(session.serverId ?? getActiveServerSnapshot().serverId);
        const rows = rowsByHome.get(serverId) ?? [];
        rows.push(buildSessionListRenderableFromSession(session));
        rowsByHome.set(serverId, rows);
    }
    for (const [serverId, rows] of rowsByHome) domain.applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' });
}

function replaceSessionListRows(domain: StorageState, rows: SessionListRenderableSession[]): void {
    domain.applyServerScopedSessionListRows('srv_active', rows, { source: 'ordinary', mode: 'replace' });
}

function patchActiveSessionListRows(domain: StorageState, patches: Parameters<StorageState['applyServerScopedSessionListRowPatches']>[1]): void {
    domain.applyServerScopedSessionListRowPatches('srv_active', patches);
}

function readSessionListIndexSessionIds(
    index: ReadonlyArray<SessionListIndexItem> | null | undefined,
): string[] {
    return (index ?? [])
        .filter((item): item is Extract<SessionListIndexItem, { type: 'session' }> => item.type === 'session')
        .map((item) => item.sessionId);
}

describe('sessions domain: unchanged writes', () => {
    it('uses the same retained persistence window for ordinary hydration and fallback finalization', () => {
        observeSessionListWarmCacheWrites();
        const { domain, get } = createHarness();
        const arrivals = Array.from({ length: SESSION_LIST_WARM_CACHE_MAX_ENTRIES + 1 }, (_, index) => (
            currentSession({ id: `window-${index}`, createdAt: index + 1, updatedAt: index + 1 })
        ));
        applyOrdinarySnapshot(domain, arrivals);
        saveWarmSessionCacheForState(get());
        const cached = warmCachePersistence.loadSessionListWarmCacheEntries(getActiveServerSnapshot().serverId, 'account_a');
        expect(Object.keys(cached)).toHaveLength(SESSION_LIST_WARM_CACHE_MAX_ENTRIES);
        expect(cached['window-0']).toBeUndefined();
        expect(Object.keys(get().sessionListRowsByServerId[getActiveServerSnapshot().serverId]))
            .toHaveLength(arrivals.length);
    });

    it.each(['apply', 'merge'] as const)('keeps the newest tuple when one %s publication contains out-of-order observations of the same row', writer => {
        const { domain, get } = createHarness();
        const serverId = getActiveServerSnapshot().serverId;
        const row = buildSessionListRenderableFromSession(currentSession({ id: 'same-batch-row',
            metadataVersion: 1, metadata: { path: '/first', host: 'home' } }));
        domain.applyServerScopedSessionListRows(serverId, [row], { source: 'rowOnly', mode: 'append' });
        const rows = [
            { ...row, metadataVersion: 3, metadata: { ...row.metadata!, path: '/newest' } },
            { ...row, metadataVersion: 2, metadata: { ...row.metadata!, path: '/older' } },
        ];
        if (writer === 'apply') domain.applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'append' });
        else domain.mergeSessionListRowsForServerScope(serverId, rows);
        expect(get().sessionListRowsByServerId[serverId]?.[row.id]).toMatchObject({
            metadataVersion: 3, metadata: { path: '/newest' },
        });
    });

    it('reuses equal nested Session data when another field really changes', () => {
        const { domain, get, getSetCalls } = createHarness();
        const input = currentSession({ id: 's1', metadata: { machineId: 'm1', path: '/repo', host: 'pub.test' } });
        domain.applySessions([input]);
        const previous = get().sessions.s1;
        const notifications = getSetCalls();
        domain.applySessions([{ ...structuredClone(input), seq: input.seq + 1 }]);
        const next = get().sessions.s1;
        expect(next.seq).toBe(input.seq + 1);
        expect(next).not.toBe(previous);
        expect(next.metadata).toBe(previous.metadata);
        expect(getSetCalls()).toBe(notifications + 1);
        const settled = get();
        domain.applySessions([{ ...structuredClone(input), seq: input.seq + 1 }]);
        expect(get()).toBe(settled);
    });

    it.each(['replace', 'merge', 'reconcile'] as const)('reuses equal nested row data through %s publication', (mode) => {
        const { domain, get } = createHarness();
        const serverId = getActiveServerSnapshot().serverId;
        const row = buildSessionListRenderableFromSession(currentSession({ id: 's1', metadata: { machineId: 'm1', path: '/repo', host: 'pub.test' } }));
        domain.applyServerScopedSessionListRows(serverId, [row], { source: 'ordinary', mode: 'replace' });
        const previousRows = get().sessionListRowsByServerId[serverId];
        const previous = previousRows.s1;
        const next = { ...structuredClone(row), seq: row.seq + 1 };
        if (mode === 'merge') domain.mergeSessionListRowsForServerScope(serverId, [next]);
        else if (mode === 'reconcile') domain.reconcileSessionListRowsForServerScope(serverId, [next], previousRows,
            captureSessionFullPublicationBaseline(serverId, Object.keys(previousRows)));
        else domain.applyServerScopedSessionListRows(serverId, [next], { source: 'ordinary', mode: 'replace' });
        expect(get().sessionListRowsByServerId[serverId].s1.seq).toBe(next.seq);
        expect(get().sessionListRowsByServerId[serverId].s1.metadata).toBe(previous.metadata);
        const retainedState = get();
        const replay = structuredClone(next);
        if (mode === 'merge') domain.mergeSessionListRowsForServerScope(serverId, [replay]);
        else if (mode === 'reconcile') domain.reconcileSessionListRowsForServerScope(serverId, [replay], retainedState.sessionListRowsByServerId[serverId],
            captureSessionFullPublicationBaseline(serverId, Object.keys(retainedState.sessionListRowsByServerId[serverId])));
        else domain.applyServerScopedSessionListRows(serverId, [replay], { source: 'ordinary', mode: 'replace' });
        expect(get()).toBe(retainedState);
    });

    it('retains equal persisted local slices across repeated scope activation and clearing', () => {
        const { domain, get, getSetCalls } = createHarness();
        const scope = { serverId: 'home', accountId: 'account_a' };
        domain.activateSessionLocalStateScope(scope);
        const settled = get();
        const notifications = getSetCalls();
        domain.activateSessionLocalStateScope({ ...scope });
        expect(get()).toBe(settled);
        expect(getSetCalls()).toBe(notifications);
        domain.clearSessionLocalStateScope();
        const cleared = get();
        domain.clearSessionLocalStateScope();
        expect(get()).toBe(cleared);
    });

    it('does not notify the real store for ready echoes and equal SCM status, while publishing fresh status', () => {
        const { domain, get, getSetCalls } = createHarness();
        const status: ScmStatus = {
            branch: 'main', isDirty: false, changedFileCount: 0, includedCount: 0, lastUpdatedAt: 1,
            includedLinesAdded: 0, includedLinesRemoved: 0, pendingLinesAdded: 0, pendingLinesRemoved: 0,
            linesAdded: 0, linesRemoved: 0, linesChanged: 0,
        };
        domain.applyReady();
        domain.applyScmStatus('s1', status);
        const settled = get();
        const notifications = getSetCalls();
        domain.applyReady();
        domain.applyScmStatus('s1', { ...status });
        expect(get()).toBe(settled);
        expect(get().sessionScmStatus.s1).toBe(status);
        expect(getSetCalls()).toBe(notifications);
        domain.applyScmStatus('s1', { ...status, lastUpdatedAt: 2 });
        expect(get().sessionScmStatus.s1?.lastUpdatedAt).toBe(2);
        expect(getSetCalls()).toBe(notifications + 1);
    });

    it.each(['session', 'workspace'] as const)('retains equal %s review drafts without notifying and still publishes edits', (kind) => {
        const { domain, get, getSetCalls } = createHarness();
        const upsert = kind === 'session' ? domain.upsertSessionReviewCommentDraft : domain.upsertWorkspaceReviewCommentDraft;
        const include = kind === 'session' ? domain.setSessionReviewCommentDraftIncluded : domain.setWorkspaceReviewCommentDraftIncluded;
        const draft = {
            id: 'comment', filePath: 'a.ts', source: 'file' as const,
            anchor: { kind: 'fileLine' as const, startLine: 1 },
            snapshot: { selectedLines: ['line'], beforeContext: [], afterContext: [] }, body: 'review', createdAt: 1,
        };
        upsert('s1', draft);
        const settled = get();
        const notifications = getSetCalls();
        upsert('s1', structuredClone(draft));
        include('s1', 'missing', false);
        include('s1', draft.id, true);
        expect(get()).toBe(settled);
        expect(getSetCalls()).toBe(notifications);
        include('s1', draft.id, false);
        expect(getSetCalls()).toBe(notifications + 1);
        const edited = get();
        include('s1', draft.id, false);
        expect(get()).toBe(edited);
        upsert('s1', { ...draft, body: 'edited' });
        expect(getSetCalls()).toBe(notifications + 2);
    });

    it('retains equal action drafts without notifying and publishes actual input/status changes', () => {
        const { domain, get, getSetCalls } = createHarness();
        const scope = { serverId: 'home', accountId: 'account_a' };
        const address = { serverId: 'home', sessionId: 's1' };
        const created = domain.createSessionActionDraft(scope, address, { actionId: 'review.start', input: { base: { kind: 'none' } } });
        const settled = get();
        const notifications = getSetCalls();
        domain.updateSessionActionDraftInput(scope, address, created.id, { base: { kind: 'none' } });
        domain.setSessionActionDraftStatus(scope, address, created.id, 'editing', null);
        expect(get()).toBe(settled);
        expect(getSetCalls()).toBe(notifications);
        domain.updateSessionActionDraftInput(scope, address, created.id, { instructions: 'review this' });
        domain.setSessionActionDraftStatus(scope, address, created.id, 'running');
        expect(getSetCalls()).toBe(notifications + 2);
        domain.clearSessionLocalStateScope();
        const beforeHydration = getSetCalls();
        domain.updateSessionActionDraftInput(scope, address, created.id, { instructions: 'review this' });
        expect(Object.values(get().sessionActionDraftsByAddressKey).flat().some((draft) => draft.id === created.id)).toBe(true);
        expect(getSetCalls()).toBe(beforeHydration + 1);
        const hydrated = get();
        domain.updateSessionActionDraftInput(scope, address, created.id, { instructions: 'review this' });
        expect(get()).toBe(hydrated);
    });

    it('publishes only real workspace SCM selection and operation changes', () => {
        const { domain, get, getSetCalls } = createHarness();
        const scope = { serverId: 'home', machineId: 'm1', rootPath: '/repo' };
        domain.markWorkspaceScmTouchedPaths(scope, ['a.ts'], 10);
        domain.markWorkspaceScmCommitSelectionPaths(scope, ['a.ts'], 10);
        domain.upsertWorkspaceScmCommitSelectionPatch(scope, { path: 'a.ts', patch: 'patch' }, 10);
        const started = domain.beginWorkspaceScmOperation(scope, 'commit');
        if (!started.started) throw new Error('Expected operation');
        domain.updateWorkspaceScmOperationProgress(scope, started.operation.id, 'running');
        const settled = get();
        const notifications = getSetCalls();
        domain.markWorkspaceScmTouchedPaths(scope, ['a.ts'], 10);
        domain.markWorkspaceScmTouchedPaths(scope, []);
        domain.markWorkspaceScmCommitSelectionPaths(scope, ['a.ts'], 10);
        domain.upsertWorkspaceScmCommitSelectionPatch(scope, { path: 'a.ts', patch: 'patch' }, 10);
        domain.pruneWorkspaceScmTouchedPaths(scope, new Set(['a.ts']));
        domain.pruneWorkspaceScmCommitSelectionPaths(scope, new Set(['a.ts']));
        domain.pruneWorkspaceScmCommitSelectionPatches(scope, new Set(['a.ts']));
        domain.unmarkWorkspaceScmCommitSelectionPaths(scope, ['missing']);
        domain.removeWorkspaceScmCommitSelectionPatch(scope, 'missing');
        domain.beginWorkspaceScmOperation(scope, 'commit');
        domain.updateWorkspaceScmOperationProgress(scope, started.operation.id, 'running');
        expect(get()).toBe(settled);
        expect(getSetCalls()).toBe(notifications);
        domain.markWorkspaceScmTouchedPaths(scope, ['a.ts'], 11);
        domain.pruneWorkspaceScmCommitSelectionPaths(scope, new Set());
        domain.pruneWorkspaceScmCommitSelectionPatches(scope, new Set());
        domain.finishWorkspaceScmOperation(scope, started.operation.id);
        expect(getSetCalls()).toBe(notifications + 4);
        const cleared = get();
        domain.clearWorkspaceScmCommitSelectionPaths(scope);
        domain.clearWorkspaceScmCommitSelectionPatches(scope);
        domain.finishWorkspaceScmOperation(scope, started.operation.id);
        expect(get()).toBe(cleared);
    });

    it.each(['session', 'workspace'] as const)('keeps equal %s project status and errors stable, including real freshness changes', (kind) => {
        const { domain, get, getSetCalls } = createHarness();
        const scope = { serverId: getActiveServerSnapshot().serverId, machineId: 'm1', rootPath: '/repo' };
        domain.applySessions([currentSession({ id: 's1', metadata: { machineId: 'm1', path: '/repo', host: 'pub.test' } })]);
        const updateStatus = (status: ScmStatus) => kind === 'session'
            ? domain.updateSessionProjectScmStatus('s1', status)
            : domain.updateWorkspaceScmStatus(scope, status);
        const updateError = (error: { message: string; at: number } | null) => kind === 'session'
            ? domain.updateSessionProjectScmSnapshotError('s1', error)
            : domain.updateWorkspaceScmSnapshotError(scope, error);
        const readStatus = () => kind === 'session' ? domain.getSessionProjectScmStatus('s1') : domain.getWorkspaceScmStatus(scope);
        const status: ScmStatus = {
            branch: 'main', isDirty: false, changedFileCount: 0, includedCount: 0, lastUpdatedAt: 1,
            includedLinesAdded: 0, includedLinesRemoved: 0, pendingLinesAdded: 0, pendingLinesRemoved: 0,
            linesAdded: 0, linesRemoved: 0, linesChanged: 0,
        };
        updateStatus(status);
        updateError({ message: 'refresh failed', at: 1 });
        const settled = get();
        const notifications = getSetCalls();
        updateStatus({ ...status });
        updateError({ message: 'refresh failed', at: 1 });
        expect(get()).toBe(settled);
        expect(readStatus()).toBe(status);
        expect(getSetCalls()).toBe(notifications);
        updateStatus({ ...status, lastUpdatedAt: 2 });
        updateError(null);
        expect(getSetCalls()).toBe(notifications + 2);
        const cleared = get();
        updateError(null);
        expect(get()).toBe(cleared);
    });
});

describe('sessions domain: sessionListIndex rebuild gating', () => {
    it('publishes a nonfocused promoted Home refresh into its canonical row and membership projection', async () => {
        const remote = await upsertServerProfile({ serverUrl: 'https://promoted-row-publication.test' });
        const { domain, get, getSetCalls } = createHarness();
        const initial = buildSessionListRenderableFromSession(currentSession({ id: 'remote-row', serverId: remote.id, archivedAt: null }));
        domain.applyServerScopedSessionListRows(remote.id, [initial], { source: 'ordinary', mode: 'replace' });
        domain.applyServerScopedSessionListRows('srv_unrelated', [
            buildSessionListRenderableFromSession(currentSession({ id: 'other-row', serverId: 'srv_unrelated' })),
        ], { source: 'ordinary', mode: 'replace' });
        const otherRows = get().sessionListRowsByServerId.srv_unrelated;
        const otherIndex = get().sessionListIndexByServerId.srv_unrelated;
        const otherMembership = get().ordinarySessionListMembershipByServerId.srv_unrelated;
        const canonicalId = 'srv_promoted_row_publication';
        await setServerProfileIdentityForUrl(remote.serverUrl, canonicalId);
        domain.applyServerScopedSessionListRows(canonicalId, [{ ...initial, archivedAt: 42 }], { source: 'archived', mode: 'replace' });

        const refreshed = { ...initial, updatedAt: 43 };
        domain.applyServerScopedSessionListRows(remote.id, [refreshed], { source: 'ordinary', mode: 'replace' });

        expect(readSessionListRowForServerId(get().sessionListRowsByServerId, canonicalId, initial.id)?.archivedAt).toBeNull();
        expect(get().sessionListRowsByServerId[remote.id]).toBeUndefined();
        expect(get().ordinarySessionListMembershipByServerId[canonicalId]).toContain(initial.id);
        expect(get().archivedSessionListMembershipByServerId[canonicalId]).not.toContain(initial.id);
        expect(get().sessionListRowsByServerId.srv_unrelated).toBe(otherRows);
        expect(get().sessionListIndexByServerId.srv_unrelated).toBe(otherIndex);
        expect(get().ordinarySessionListMembershipByServerId.srv_unrelated).toBe(otherMembership);
        const publishedRows = get().sessionListRowsByServerId[canonicalId];
        const notifications = getSetCalls();
        domain.applyServerScopedSessionListRows(remote.id, [refreshed], { source: 'ordinary', mode: 'replace' });
        expect(get().sessionListRowsByServerId[canonicalId]).toBe(publishedRows);
        expect(getSetCalls()).toBe(notifications);
    });

    it.each(['hydration', 'merge', 'reconcile'] as const)('publishes a captured alias through the real %s row owner after Home promotion', async mode => {
        const remote = await upsertServerProfile({ serverUrl: `https://promoted-row-${mode}.test` });
        const { domain, get } = createHarness();
        const session = currentSession({ id: 'captured-alias-row', serverId: remote.id, updatedAt: 1 });
        domain.applyServerScopedSessionListRows(remote.id, [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'replace' });
        const canonicalId = `srv_promoted_row_${mode}`;
        await setServerProfileIdentityForUrl(remote.serverUrl, canonicalId);
        domain.applyServerScopedSessionListRows(canonicalId, [buildSessionListRenderableFromSession({ ...session, updatedAt: 2 })], { source: 'ordinary', mode: 'replace' });
        const baseline = get().sessionListRowsByServerId[canonicalId];
        const refreshed = { ...session, updatedAt: 43 };
        const row = buildSessionListRenderableFromSession(refreshed);

        if (mode === 'hydration') domain.applySessions([refreshed]);
        else if (mode === 'merge') domain.mergeSessionListRowsForServerScope(remote.id, [row]);
        else domain.reconcileSessionListRowsForServerScope(remote.id, [row], baseline,
            captureSessionFullPublicationBaseline(canonicalId, Object.keys(baseline)));

        expect(readSessionListRowForServerId(get().sessionListRowsByServerId, canonicalId, session.id)?.updatedAt).toBe(43);
        expect(get().sessionListRowsByServerId[remote.id]).toBeUndefined();
        expect(get().ordinarySessionListMembershipByServerId[canonicalId]).toContain(session.id);
    });

    it('clears every retained row and membership alias of a promoted Home without reviving a fallback', async () => {
        const remote = await upsertServerProfile({ serverUrl: 'https://promoted-row-clear.test' });
        const { domain, get } = createHarness();
        const row = buildSessionListRenderableFromSession(currentSession({ id: 'cleared-remote-row', serverId: remote.id }));
        domain.applyServerScopedSessionListRows(remote.id, [row], { source: 'ordinary', mode: 'replace' });
        domain.applyServerScopedSessionListRows('srv_unrelated', [
            buildSessionListRenderableFromSession(currentSession({ id: 'retained-other-row', serverId: 'srv_unrelated' })),
        ], { source: 'ordinary', mode: 'replace' });
        const otherRows = get().sessionListRowsByServerId.srv_unrelated;
        const otherIndex = get().sessionListIndexByServerId.srv_unrelated;
        const canonicalId = 'srv_promoted_row_clear';
        await setServerProfileIdentityForUrl(remote.serverUrl, canonicalId);

        domain.clearSessionListRowsForServerScope(canonicalId);

        expect(readSessionListRowsForServerId(get().sessionListRowsByServerId, canonicalId)).toBeNull();
        for (const id of [remote.id, canonicalId]) {
            expect(get().sessionListRowsByServerId[id]).toBeUndefined();
            expect(get().sessionListIndexByServerId[id]).toBeUndefined();
            expect(get().ordinarySessionListMembershipByServerId[id]).toBeUndefined();
            expect(get().archivedSessionListMembershipByServerId[id]).toBeUndefined();
        }
        expect(get().sessionListRowsByServerId.srv_unrelated).toBe(otherRows);
        expect(get().sessionListIndexByServerId.srv_unrelated).toBe(otherIndex);
    });

    it('keeps linked-session storage and qualified identity through compact row and index projection', () => {
        const session = createDemoOpenCodeSessionFixture({ serverId: 'srv_active' });
        const link = readExternalSessionLink(session.metadata);
        if (!session.metadata || !link?.qualifiedIdentity) throw new Error('Expected a qualified linked-session fixture');
        const row = buildSessionListRenderableFromSession(session);
        expect(getSessionStorageKind(row)).toBe('direct');
        expect(buildSessionListIndexFromViewData([{ type: 'session', session: row }])).toContainEqual(
            expect.objectContaining({ type: 'session', sessionId: session.id, storageKind: 'direct' }),
        );
        expect(row.metadata?.externalSessionV1).toMatchObject({
            qualifiedIdentity: link.qualifiedIdentity,
        });
        const same = buildSessionListRenderableFromSession({ ...session, metadata: { ...session.metadata,
            externalSessionV1: { ...link, qualifiedIdentity: { ...link.qualifiedIdentity,
                agent: { ...link.qualifiedIdentity.agent }, source: { ...link.qualifiedIdentity.source } } },
        } }, row);
        expect(same.metadata).toBe(row.metadata);

        const replacementIdentity = { ...link.qualifiedIdentity,
            agent: { ...link.qualifiedIdentity.agent, pluginId: 'example.agent.opencode' } };
        const changed = buildSessionListRenderableFromSession({ ...session, metadata: { ...session.metadata,
            externalSessionV1: { ...link, qualifiedIdentity: replacementIdentity },
        } }, row);
        expect(changed.metadata).not.toBe(row.metadata);
        expect(changed.metadata?.externalSessionV1).toMatchObject({ qualifiedIdentity: replacementIdentity });
        expect(getSessionStorageKind(changed)).toBe('direct');
    });

    it('lazily registers loaded sessions before writing per-session project SCM snapshots', async () => {
        observeSessionListWarmCacheWrites();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const session = currentSession({
            id: 's1',
            serverId: 'srv_active',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'srv_active:m1:/home/u/repo',
            fetchedAt: 123,
            repo: {
                isRepo: true,
                rootPath: '/home/u/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/home/u/repo', branch: 'main', isCurrent: true }],
            },
            branch: {
                head: 'main',
                upstream: null,
                ahead: 0,
                behind: 0,
                detached: false,
            },
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };

        const { domain } = createHarness({
            sessions: { s1: session },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        expect(projectManager.getProjectForSession('s1')).toBeNull();

        domain.updateSessionProjectScmSnapshot('s1', snapshot);

        expect(domain.getSessionProjectScmSnapshot('s1')).toBe(snapshot);
        expect(projectManager.getProjectForSession('s1')?.sessionIds).toEqual(['s1']);
    });

    it('does not notify storage when SCM snapshot refreshes only change fetchedAt', async () => {
        observeSessionListWarmCacheWrites();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const session = currentSession({
            id: 's1',
            serverId: 'srv_active',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } satisfies Session);
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'srv_active:m1:/home/u/repo',
            fetchedAt: 123,
            repo: {
                isRepo: true,
                rootPath: '/home/u/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/home/u/repo', branch: 'main', isCurrent: true }],
            },
            branch: {
                head: 'main',
                upstream: null,
                ahead: 0,
                behind: 0,
                detached: false,
            },
            hasConflicts: false,
            entries: [
                {
                    path: 'src/app.ts',
                    previousPath: null,
                    kind: 'modified',
                    includeStatus: 'modified',
                    pendingStatus: 'modified',
                    hasIncludedDelta: false,
                    hasPendingDelta: true,
                    stats: {
                        includedAdded: 0,
                        includedRemoved: 0,
                        pendingAdded: 1,
                        pendingRemoved: 1,
                        isBinary: false,
                    },
                },
            ],
            totals: {
                includedFiles: 0,
                pendingFiles: 1,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 1,
            },
        };

        const { domain, getSetCalls } = createHarness({
            sessions: { s1: session },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        domain.updateSessionProjectScmSnapshot('s1', snapshot);
        expect(getSetCalls()).toBe(1);

        domain.updateSessionProjectScmSnapshot('s1', {
            ...snapshot,
            fetchedAt: 456,
        });
        expect(getSetCalls()).toBe(1);

        const scope = { serverId: 'srv_active', machineId: 'm1', rootPath: '/home/u/other-repo' };
        const workspaceSnapshot = {
            ...snapshot,
            projectKey: 'srv_active:m1:/home/u/other-repo',
            repo: {
                ...snapshot.repo,
                rootPath: '/home/u/other-repo',
                worktrees: [{ path: '/home/u/other-repo', branch: 'main', isCurrent: true }],
            },
        } satisfies ScmWorkingSnapshot;

        domain.updateWorkspaceScmSnapshot(scope, workspaceSnapshot);
        expect(getSetCalls()).toBe(2);

        domain.updateWorkspaceScmSnapshot(scope, {
            ...workspaceSnapshot,
            fetchedAt: 789,
        });
        expect(getSetCalls()).toBe(2);
    });

    it('builds an empty sessionListIndex when the server snapshot returns zero sessions', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        expect(get().sessionListIndexByServerId?.['srv_active']).toBeUndefined();

        replaceSessionListRows(domain, []);

        expect(Array.isArray(get().sessionListIndexByServerId?.['srv_active'])).toBe(true);
        expect(get().sessionListIndexByServerId?.['srv_active']?.length).toBe(0);
    });

    it('initializes the active-server sessionListIndex when a no-op patch arrives before the index exists', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        const session = currentSession({
            id: 's1',
            serverId: 'srv_active',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: {
                name: 'Session',
                path: '/repo',
                host: 'host-1',
                machineId: 'm1',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } satisfies Session);
        replaceSessionListRows(domain, [
            buildSessionListRenderableFromSession(session),
        ]);
        get().sessionListIndexByServerId = {};

        patchActiveSessionListRows(domain, [
            { sessionId: 's1', patch: { pendingCount: (get().sessionListRowsByServerId['srv_active'] ?? {}).s1.pendingCount } },
        ]);

        expect(Array.isArray(get().sessionListIndexByServerId?.['srv_active'])).toBe(true);
        const activeServerIndex = get().sessionListIndexByServerId?.['srv_active'] as ReadonlyArray<SessionListIndexItem> | undefined;
        expect(activeServerIndex?.some(
            (item) => item.type === 'session' && item.sessionId === 's1',
        )).toBe(true);
    });

    it('tracks the active-server sessionListIndex in sessionListIndexByServerId', async () => {

        await activateTestHome('srv_active');
        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(Array.isArray(get().sessionListIndexByServerId?.['srv_active'])).toBe(true);
    });

    it('reuses the server-scoped previous index when rebuilding the active server index', async () => {

        await activateTestHome('srv_b');
        observeSessionListWarmCacheWrites();

        const session = currentSession({
            id: 's1',
            serverId: 'srv_b',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any);

        const { get, set, domain } = createHarness();
        domain.applyServerScopedSessionListRows('srv_b', [buildSessionListRenderableFromSession(session)], {
            source: 'ordinary', mode: 'replace',
        });
        const precomputedIndex = get().sessionListIndexByServerId.srv_b;
        set({ sessions: {}, sessionListRowsByServerId: {} });

        domain.applySessions([session]);

        expect(get().sessionListIndexByServerId.srv_b).toBe(precomputedIndex);
    });

    it('does not call projectManager.updateSessions for non-project-structural session updates', async () => {
        const updateSessions = vi.spyOn(projectManager, 'updateSessions');

        observeSessionListWarmCacheWrites();

        const { domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);
        expect(updateSessions).toHaveBeenCalledTimes(1);

        domain.applySessions([
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: null,
                metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);
        expect(updateSessions).toHaveBeenCalledTimes(1);
    });

    it('keeps the active-server sessionListIndex reference stable for non-structural applySessions updates', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
    });

    it('rebuilds inactive date-grouped sessionListIndex when meaningful activity changes ordering', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness({
            settings: {
                sessionListLayoutV1: 'recent_activity',
            },
        });
        expect(get().settings.sessionListLayoutV1).toBe('recent_activity');

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 100,
                meaningfulActivityAt: 100,
                active: false,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
            currentSession({
                id: 's2',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 2,
                updatedAt: 200,
                meaningfulActivityAt: 200,
                active: false,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(readSessionListIndexSessionIds(initialIndex)).toEqual(['s2', 's1']);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 2,
                createdAt: 1,
                updatedAt: 300,
                meaningfulActivityAt: 300,
                active: false,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const nextIndex = get().sessionListIndexByServerId['srv_active'];
        expect(nextIndex).not.toBe(initialIndex);
        expect(readSessionListIndexSessionIds(nextIndex)).toEqual(['s1', 's2']);
    });

    it('reuses the previous renderable object for semantically identical applySessions refreshes', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialRenderable = (get().sessionListRowsByServerId['srv_active'] ?? {})['s1'];
        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(initialRenderable).toBeDefined();
        expect(Array.isArray(initialIndex)).toBe(true);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect((get().sessionListRowsByServerId['srv_active'] ?? {})['s1']).toBe(initialRenderable);
        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
    });

    it('preserves ready metadata across applySessions refresh rows that omit it', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 10,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                lastViewedSessionSeq: 8,
                latestTurnStatus: 'in_progress',
                latestReadyEventSeq: 9,
                latestReadyEventAt: 9_000,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 10,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                lastViewedSessionSeq: 8,
                latestTurnStatus: 'in_progress',
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessions.s1.latestReadyEventSeq).toBe(9);
        expect(get().sessions.s1.latestReadyEventAt).toBe(9_000);
        expect((get().sessionListRowsByServerId['srv_active'] ?? {}).s1.latestReadyEventSeq).toBe(9);
        expect((get().sessionListRowsByServerId['srv_active'] ?? {}).s1.latestReadyEventAt).toBe(9_000);
        expect(get().sessionListRowsByServerId['srv_active'].s1.latestReadyEventSeq).toBe(9);
        expect(get().sessionListRowsByServerId['srv_active'].s1.latestReadyEventAt).toBe(9_000);
    });

    it('keeps terminal unread renderables unread when only a partial transcript slice is cached', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness({
            sessionMessages: {
                s1: {
                    isLoaded: false,
                    messageIdsOldestFirst: ['old'],
                    messagesById: {
                        old: {
                            id: 'old',
                            kind: 'agent-text',
                            seq: 110,
                            localId: null,
                            createdAt: 1,
                            text: 'older visible message',
                        },
                    },
                },
            },
        });

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 742,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 1,
                lastViewedSessionSeq: 741,
                latestTurnStatus: 'completed',
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect((get().sessionListRowsByServerId['srv_active'] ?? {}).s1.hasUnreadMessages).toBe(true);
        expect(get().sessionListRowsByServerId['srv_active'].s1.hasUnreadMessages).toBe(true);
    });

    it('keeps the active-server sessionListIndex stable when ready metadata only changes row overlay state', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 10,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                lastViewedSessionSeq: 4,
                latestTurnStatus: 'in_progress',
                latestReadyEventSeq: 4,
                latestReadyEventAt: 4_000,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);
        const initialIndex = get().sessionListIndexByServerId['srv_active'];

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 11,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 1,
                lastViewedSessionSeq: 4,
                latestTurnStatus: 'in_progress',
                latestReadyEventSeq: 5,
                latestReadyEventAt: 5_000,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
        expect((get().sessionListRowsByServerId['srv_active'] ?? {}).s1.latestReadyEventSeq).toBe(5);
        expect((get().sessionListRowsByServerId['srv_active'] ?? {}).s1.latestReadyEventAt).toBe(5_000);
        expect((get().sessionListRowsByServerId['srv_active'] ?? {}).s1.hasUnreadMessages).toBe(true);
        expect(get().sessionListRowsByServerId['srv_active'].s1.latestReadyEventSeq).toBe(5);
        expect(get().sessionListRowsByServerId['srv_active'].s1.latestReadyEventAt).toBe(5_000);
        expect(get().sessionListRowsByServerId['srv_active'].s1.hasUnreadMessages).toBe(true);
    });

    it('reuses the previous session object for semantically identical applySessions refreshes', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    summary: { text: 'hello', updatedAt: 1 },
                },
                metadataVersion: 1,
                agentState: {
                    requests: {},
                    completedRequests: {},
                    localControl: null,
                    capabilities: {},
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                todos: [
                    {
                        id: 'todo-1',
                        content: 'Check session reuse',
                        status: 'pending',
                        priority: 'medium',
                    },
                ],
                ownerProfile: {
                    id: 'owner-1',
                    username: 'owner',
                    firstName: 'Own',
                    lastName: 'Er',
                    avatar: null,
                },
                accessLevel: 'admin',
                canApprovePermissions: true,
            } as any),
        ]);

        const initialSession = get().sessions['s1'];
        expect(initialSession).toBeDefined();

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    summary: { text: 'hello', updatedAt: 1 },
                },
                metadataVersion: 1,
                agentState: {
                    requests: {},
                    completedRequests: {},
                    localControl: null,
                    capabilities: {},
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                todos: [
                    {
                        id: 'todo-1',
                        content: 'Check session reuse',
                        status: 'pending',
                        priority: 'medium',
                    },
                ],
                ownerProfile: {
                    id: 'owner-1',
                    username: 'owner',
                    firstName: 'Own',
                    lastName: 'Er',
                    avatar: null,
                },
                accessLevel: 'admin',
                canApprovePermissions: true,
            } as any),
        ]);

        expect(get().sessions['s1']).toBe(initialSession);
    });

    it('keeps store collection references stable for active session heartbeat updates', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any),
        ]);

        const initialSession = get().sessions.s1;
        const initialSessions = get().sessions;
        const initialRenderables = (get().sessionListRowsByServerId['srv_active'] ?? {});
        const initialIndex = get().sessionListIndexByServerId['srv_active'];

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any),
        ]);

        expect(get().sessions.s1).toBe(initialSession);
        expect(get().sessions.s1?.activeAt).toBe(1);
        expect(get().sessions).toBe(initialSessions);
        expect((get().sessionListRowsByServerId['srv_active'] ?? {})).toBe(initialRenderables);
        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
    });

    it('skips map churn and warm-cache writes for a semantically identical applySessions batch', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialSessions = get().sessions;
        const initialRenderables = (get().sessionListRowsByServerId['srv_active'] ?? {});
        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        const saveWarmCache = warmCacheWrites;
        expect(Array.isArray(initialIndex)).toBe(true);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(get().sessions).toBe(initialSessions);
        expect((get().sessionListRowsByServerId['srv_active'] ?? {})).toBe(initialRenderables);
        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);
    });

    it('preserves previous warm-cache metadata when applySessions receives a stale replacement row', async () => {
        await activateTestHome('srv_one');
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

        observeSessionListWarmCacheWrites();

        const { domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_one',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                metadata: {
                    name: 'Cached title',
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                },
                metadataVersion: 1,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_one',
                seq: 1,
                createdAt: 1,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                metadata: null,
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        await vi.advanceTimersByTimeAsync(1_000);

        const saveWarmCache = warmCacheWrites;
        const lastCall = saveWarmCache.mock.calls.at(-1);
        const entries = lastCall?.[2] as Record<string, any>;

        expect(entries?.s1).toEqual(expect.objectContaining({
            sessionId: 's1',
            updatedAt: 20,
            metadataVersion: 1,
            agentStateVersion: 0,
            name: 'Cached title',
            path: '/home/u/repo',
            homeDir: '/home/u',
            machineId: 'm1',
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        }));
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('preserves transient renderable visibility flags across applySessions refreshes', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        get().sessionListRowsByServerId = { ...get().sessionListRowsByServerId, srv_active: {
            s1: {
                ...buildSessionListRenderableFromSession(currentSession({
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                } as any)),
                keepVisibleWhenInactive: true,
            },
        } };

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: false,
                activeAt: 2,
                archivedAt: null,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect((get().sessionListRowsByServerId['srv_active'] ?? {})['s1']?.keepVisibleWhenInactive).toBe(true);
    });

    it('keeps the active-server sessionListIndex reference stable for non-structural renderable patches', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        replaceSessionListRows(domain, [
            buildSessionListRenderableFromSession(currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any)),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        patchActiveSessionListRows(domain, [
            {
                sessionId: 's1',
                patch: {
                    pendingCount: 4,
                    pendingVersion: 8,
                },
            },
        ]);

        expect((get().sessionListRowsByServerId['srv_active'] ?? {})['s1']).toEqual(expect.objectContaining({
            pendingCount: 4,
            pendingVersion: 8,
        }));
        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
    });

    it('tracks canonical server-scoped session list index/rows for the active server', async () => {

        await activateTestHome('srv_one');
        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_one',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(get().sessionListRowsByServerId).toBeDefined();
        expect(get().sessionListIndexByServerId).toBeDefined();
        expect(get().sessionListRowsByServerId['srv_one']?.s1).toBeDefined();

        const initialIndex = get().sessionListIndexByServerId['srv_one'];
        expect(Array.isArray(initialIndex)).toBe(true);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_one',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_one']).toBe(initialIndex);
    });

    it('keeps owner-scoped sessions out of the active-server row/index state', async () => {

        await activateTestHome('srv_active');
        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 'owner-session',
                serverId: 'srv_owner',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(get().sessionListRowsByServerId['srv_active']?.['owner-session']).toBeUndefined();
        expect(
            get().sessionListIndexByServerId['srv_active']?.some(
                (item: SessionListIndexItem) => item.type === 'session' && item.sessionId === 'owner-session',
            ) ?? false,
        ).toBe(false);
        expect(get().sessionListRowsByServerId['srv_owner']?.['owner-session']).toBeDefined();
        expect(
            get().sessionListIndexByServerId['srv_owner']?.some(
                (item: SessionListIndexItem) => item.type === 'session' && item.sessionId === 'owner-session',
            ) ?? false,
        ).toBe(true);
    });

    it('keeps each Home row and index when another Home publishes the same Session id', async () => {

        await activateTestHome('srv_active');
        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        const baseSession = currentSession({
            id: 'owner-move-session',
            serverId: 'srv_owner',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', name: 'Owner Session' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any);

        applyOrdinarySnapshot(domain, [baseSession]);

        const ownerRenderable = get().sessionListRowsByServerId['srv_owner']?.['owner-move-session'];
        const ownerIndex = get().sessionListIndexByServerId['srv_owner'];
        const initialActiveIndex = get().sessionListIndexByServerId['srv_active'];
        expect(ownerRenderable).toBeDefined();
        expect(readSessionListIndexSessionIds(ownerIndex)).toContain(baseSession.id);
        expect(get().sessionListRowsByServerId['srv_owner']?.['owner-move-session']).toBe(ownerRenderable);
        expect(
            initialActiveIndex?.some(
                (item: SessionListIndexItem) => item.type === 'session' && item.sessionId === 'owner-move-session',
            ) ?? false,
        ).toBe(false);

        applyOrdinarySnapshot(domain, [
            {
                ...baseSession,
                serverId: 'srv_active',
                metadata: { path: '/repo', host: 'test', ...baseSession.metadata, name: 'Active Session' },
            },
        ]);

        const activeRenderable = get().sessionListRowsByServerId['srv_active']?.['owner-move-session'];
        expect(activeRenderable).toMatchObject({ id: baseSession.id });
        expect(get().sessions[baseSession.id]?.serverId).toBe('srv_active');
        expect(activeRenderable?.metadata?.name).toBe('Active Session');
        expect(activeRenderable).not.toBe(ownerRenderable);
        expect(
            get().sessionListIndexByServerId['srv_active']?.some(
                (item: SessionListIndexItem) => item.type === 'session' && item.sessionId === 'owner-move-session',
            ) ?? false,
        ).toBe(true);
        expect(get().sessionListRowsByServerId['srv_owner']?.['owner-move-session']).toBe(ownerRenderable);
        expect(ownerRenderable?.metadata?.name).toBe('Owner Session');
        expect(get().sessionListIndexByServerId['srv_owner']).toBe(ownerIndex);
        expect(readSessionListIndexSessionIds(ownerIndex)).toContain(baseSession.id);
    });

    it('keeps equivalent owner server ids in the active-server row/index state', async () => {

        const alias = await activateTestHome('srv_stack', 'http://localhost:53288');

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 'equivalent-owner-session',
                serverId: alias.id,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const activeServerRows = get().sessionListRowsByServerId.srv_stack;
        const activeServerIndex = get().sessionListIndexByServerId.srv_stack;

        expect(activeServerRows?.['equivalent-owner-session']).toBeDefined();
        expect(
            activeServerIndex?.some(
                (item: SessionListIndexItem) => item.type === 'session' && item.sessionId === 'equivalent-owner-session',
            ) ?? false,
        ).toBe(true);
        expect(get().sessionListRowsByServerId[alias.id]?.['equivalent-owner-session']).toBeUndefined();
    });

    it('removes stale exact-alias row/index projections after equivalent owner sessions converge to the active server', async () => {
        await initializeRealAppRuntimeForTests();
        const previousState = storage.getState();
        storage.setState(storage.getInitialState(), true);
        const http = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(http);
        const serverUrl = 'https://session-index-alias.test';
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        let identifiedConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        try {
            const aliasId = await http.addHome({ serverUrl, name: 'Index Home', accountId: 'account_a', active: false });
            const emptyPage = V2SessionListResponseSchema.parse({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            });
            http.answer(aliasId, '/v2/sessions', { body: emptyPage });
            http.answer(aliasId, '/v2/sessions/active', { body: emptyPage });
            http.answer(aliasId, '/v2/session-organization', { body: SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [],
                    folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
            }) });
            http.answer(aliasId, '/v1/machines', { body: [] });
            connection = await restoreServerAccountForTest({
                serverUrl, accountId: 'account_a', request: http.request, configureSocket: configureConnectedServerSocketBoundary,
            });
            const { sync } = syncModule;
            await sync.refreshSessions({ awaitSessionListHydration: true });
            const domain = storage.getState();
            const get = storage.getState;
            const staleSession = currentSession({
                id: 'stale-alias-session',
                serverId: aliasId,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', host: 'host', path: '/home/u/stale', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            });
            domain.applyServerScopedSessionListRows(aliasId, [buildSessionListRenderableFromSession(staleSession)], {
                source: 'ordinary', mode: 'replace',
            });
            await adoptHomeProfile({
                source: 'manual', descriptor: { serverUrl, homeServerIdentityId: 'srv_stack' },
            });
            identifiedConnection = await restoreServerAccountForTest({
                serverUrl, serverIdentityId: 'srv_stack', accountId: 'account_a', activation: 'switch',
                request: http.request, configureSocket: configureConnectedServerSocketBoundary,
            });
            await sync.refreshSessions({ awaitSessionListHydration: true });

            applyOrdinarySnapshot(domain, [
                currentSession({
                    id: 'equivalent-owner-session',
                    serverId: aliasId,
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', host: 'host', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                }),
            ]);

            expect(get().sessionListRowsByServerId.srv_stack?.['equivalent-owner-session']).toBeDefined();
            expect(
                get().sessionListIndexByServerId.srv_stack?.some(
                    (item: SessionListIndexItem) => item.type === 'session' && item.sessionId === 'equivalent-owner-session',
                ) ?? false,
            ).toBe(true);
            expect(get().sessionListRowsByServerId[aliasId]).toBeUndefined();
            expect(get().sessionListIndexByServerId[aliasId]).toBeUndefined();
        } finally {
            await identifiedConnection?.dispose();
            await connection?.dispose();
            await http.reset();
            storage.setState(previousState, true);
        }
    });

    it('keeps canonical server-scoped session list index/rows in sync when deleting a session', async () => {

        await activateTestHome('srv_one');
        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_one',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_one'];
        expect(get().sessionListRowsByServerId['srv_active']).toBeUndefined();
        expect(Array.isArray(initialIndex)).toBe(true);
        expect(get().sessionListRowsByServerId['srv_one']?.['s1']).toBeDefined();

        domain.deleteSession('s1');

        const nextIndex = get().sessionListIndexByServerId['srv_one'];
        expect(get().sessionListRowsByServerId['srv_active']).toBeUndefined();
        expect(Array.isArray(nextIndex)).toBe(true);
        expect(nextIndex).not.toBe(initialIndex);
        expect(nextIndex?.some((item: any) => item.type === 'session' && item.sessionId === 's1')).toBe(false);
        expect(get().sessionListRowsByServerId['srv_one']?.['s1']).toBeUndefined();
    });

    it('keeps the active-server sessionListIndex reference stable for non-structural renderable replacement', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        replaceSessionListRows(domain, [
            buildSessionListRenderableFromSession(currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any)),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        replaceSessionListRows(domain, [
            {
                ...(get().sessionListRowsByServerId['srv_active'] ?? {})['s1'],
                updatedAt: 2,
                presence: 2,
                pendingCount: 4,
                pendingVersion: 8,
            },
        ]);

        expect((get().sessionListRowsByServerId['srv_active'] ?? {})['s1']).toEqual(expect.objectContaining({
            updatedAt: 2,
            pendingCount: 4,
            pendingVersion: 8,
        }));
        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
    });

    it('repairs stale active-server row/index projections when an identical snapshot confirms warm-cache renderables', async () => {

        observeSessionListWarmCacheWrites();

        const session = currentSession({
            id: 'warm-cache-session',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            archivedAt: null,
            pendingCount: 0,
            pendingVersion: 1,
            metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as Session);
        const warmCachedRenderable = buildSessionListRenderableFromSession(session);

        const { get, domain } = createHarness({
            sessionListRowsByServerId: {
                'srv_active': { [warmCachedRenderable.id]: warmCachedRenderable },
            },
            ordinarySessionListMembershipByServerId: { 'srv_active': [warmCachedRenderable.id] },
            sessionListIndexByServerId: {
                'srv_active': [],
            },
        });

        applyOrdinarySnapshot(domain, [session]);

        expect(get().sessionListRowsByServerId['srv_active']?.[warmCachedRenderable.id]).toBe(warmCachedRenderable);
        expect(get().sessionListIndexByServerId['srv_active']?.some(
            (item: SessionListIndexItem) => item.type === 'session' && item.sessionId === warmCachedRenderable.id,
        )).toBe(true);
    });

    it('keeps sessionListIndex stable when peer updates only change heartbeat and progress fields', async () => {
        const updateSessions = vi.spyOn(projectManager, 'updateSessions');

        observeSessionListWarmCacheWrites();

        const { buildMachineDisplayRenderableFromMachine } = await import('../../domains/machines/machineDisplayRenderable');

        const { get, domain } = createHarness();

        const machineA = {
            id: 'm-a',
            active: true,
            activeAt: 100,
            metadata: { host: 'host-a' },
        } as any;
        const machineB = {
            id: 'm-b',
            active: true,
            activeAt: 200,
            metadata: { host: 'host-b' },
        } as any;

        get().machines = {
            'm-a': machineA,
            'm-b': machineB,
        };
        get().machineDisplayById = {
            'm-a': buildMachineDisplayRenderableFromMachine(machineA),
            'm-b': buildMachineDisplayRenderableFromMachine(machineB),
        };

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                metadata: { machineId: 'm-stale', host: 'host-stale', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
            currentSession({
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-a', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
            currentSession({
                id: 's3',
                seq: 3,
                createdAt: 3,
                updatedAt: 200,
                active: true,
                activeAt: 200,
                metadata: { machineId: 'm-b', host: 'host-b', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);
        expect(updateSessions).toHaveBeenCalledTimes(1);

        domain.applySessions([
            currentSession({
                id: 's2',
                seq: 4,
                createdAt: 2,
                updatedAt: 300,
                meaningfulActivityAt: 300,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-a', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
        expect(updateSessions).toHaveBeenCalledTimes(1);
    });

    it('skips reachable peer scans for row-only applySessions updates that cannot affect canonical targets', async () => {
        const updateSessions = vi.spyOn(projectManager, 'updateSessions');

        observeSessionListWarmCacheWrites();

        const resolveSessionMachineRpcTargetSpy = vi.spyOn(reachableTargets, 'resolveSessionMachineRpcTarget');

        const { buildMachineDisplayRenderableFromMachine } = await import('../../domains/machines/machineDisplayRenderable');

        const { get, domain } = createHarness();

        const machineA = {
            id: 'm-a',
            active: true,
            activeAt: 100,
            metadata: { host: 'host-a' },
        } as any;
        const machineB = {
            id: 'm-b',
            active: true,
            activeAt: 200,
            metadata: { host: 'host-b' },
        } as any;

        get().machines = {
            'm-a': machineA,
            'm-b': machineB,
        };
        get().machineDisplayById = {
            'm-a': buildMachineDisplayRenderableFromMachine(machineA),
            'm-b': buildMachineDisplayRenderableFromMachine(machineB),
        };

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                metadata: { machineId: 'm-stale', host: 'host-stale', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
            currentSession({
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-a', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
            currentSession({
                id: 's3',
                seq: 3,
                createdAt: 3,
                updatedAt: 200,
                active: true,
                activeAt: 200,
                metadata: { machineId: 'm-b', host: 'host-b', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);
        const initialResolveCallCount = resolveSessionMachineRpcTargetSpy.mock.calls.length;

        domain.applySessions([
            currentSession({
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-a', host: 'host-a', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
        expect(resolveSessionMachineRpcTargetSpy).toHaveBeenCalledTimes(initialResolveCallCount);
    });

    it('skips reachable peer scans for active metadata-version-only updates with explicit canonical targets', async () => {
        const updateSessions = vi.spyOn(projectManager, 'updateSessions');

        observeSessionListWarmCacheWrites();

        const resolveSessionMachineRpcTargetSpy = vi.spyOn(reachableTargets, 'resolveSessionMachineRpcTarget');

        const { buildMachineDisplayRenderableFromMachine } = await import('../../domains/machines/machineDisplayRenderable');

        const { get, domain } = createHarness();

        const machine = {
            id: 'm-a',
            active: true,
            activeAt: 100,
            metadata: { host: 'host-a' },
        } as any;
        get().machines = { 'm-a': machine };
        get().machineDisplayById = { 'm-a': buildMachineDisplayRenderableFromMachine(machine) };

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                metadata: {
                    machineId: 'm-a',
                    host: 'host-a',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    name: 'Initial title',
                },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);
        const initialResolveCallCount = resolveSessionMachineRpcTargetSpy.mock.calls.length;

        domain.applySessions([
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 101,
                active: true,
                activeAt: 100,
                metadata: {
                    machineId: 'm-a',
                    host: 'host-a',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    name: 'Updated title',
                    summaryText: 'Updated non-reachability summary',
                },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
        expect(resolveSessionMachineRpcTargetSpy).toHaveBeenCalledTimes(initialResolveCallCount);
        expect(updateSessions).toHaveBeenCalledTimes(1);
    });

    it('rebuilds sessionListIndex when a peer Session changes its project machine and can retarget a stale session', async () => {
        const updateSessions = vi.spyOn(projectManager, 'updateSessions');
        const resolveSessionMachineRpcTargetSpy = vi.spyOn(reachableTargets, 'resolveSessionMachineRpcTarget');

        observeSessionListWarmCacheWrites();

        const { buildMachineDisplayRenderableFromMachine } = await import('../../domains/machines/machineDisplayRenderable');

        const { get, domain } = createHarness();

        const machineA = {
            id: 'm-a',
            active: true,
            activeAt: 100,
            metadata: { host: 'host-a' },
        } as any;
        const machineB = {
            id: 'm-b',
            active: true,
            activeAt: 200,
            metadata: { host: 'host-b' },
        } as any;

        get().machines = {
            'm-a': machineA,
            'm-b': machineB,
        };
        get().machineDisplayById = {
            'm-a': buildMachineDisplayRenderableFromMachine(machineA),
            'm-b': buildMachineDisplayRenderableFromMachine(machineB),
        };

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                metadata: { path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
            currentSession({
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-b', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);
        const initialResolveCallCount = resolveSessionMachineRpcTargetSpy.mock.calls.length;

        domain.applySessions([
            currentSession({
                id: 's2',
                seq: 2,
                createdAt: 2,
                updatedAt: 101,
                active: true,
                activeAt: 100,
                metadata: { machineId: 'm-a', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).not.toBe(initialIndex);
        expect(resolveSessionMachineRpcTargetSpy.mock.calls.length).toBeGreaterThan(initialResolveCallCount);
        expect(updateSessions).toHaveBeenCalled();
    });

    it('rebuilds the active-server sessionListIndex for structural applySessions changes (grouping keys)', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/other', homeDir: '/home/u' },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).not.toBe(initialIndex);
    });

    it('rebuilds the active-server sessionListIndex when archivedAt changes (visibility)', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: 123,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).not.toBe(initialIndex);
    });

    it('rebuilds the active-server sessionListIndex when direct-session storage classification changes', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: null,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    externalSessionV1: createDemoOpenCodeSessionFixture({ serverId: 'srv_active' }).metadata?.externalSessionV1,
                },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).not.toBe(initialIndex);
        expect(get().sessionListIndexByServerId.srv_active).toContainEqual(
            expect.objectContaining({ type: 'session', sessionId: 's1', storageKind: 'direct' }),
        );
    });

    it('preserves linked direct-session metadata when a later refresh omits externalSessionV1', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: {
                    machineId: 'm1',
                    host: 'h1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'm1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'claudeConfigDir', configDir: '/tmp/claude' },
                    },
                },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(getSessionStorageKind(get().sessions.s1)).toBe('direct');
        expect(
            get().sessionListIndexByServerId['srv_active']?.some(
                (item: any) => item.type === 'session' && item.sessionId === 's1' && (item.storageKind ?? 'persisted') === 'direct',
            ),
        ).toBe(true);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: null,
                metadata: {
                    machineId: 'm1',
                    host: 'h1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect((get().sessions.s1?.metadata as any)?.externalSessionV1).toEqual(expect.objectContaining({
            v: 1,
            agentId: 'claude',
            remoteSessionId: 'remote-1',
        }));
        expect(getSessionStorageKind(get().sessions.s1)).toBe('direct');
        expect(
            get().sessionListIndexByServerId['srv_active']?.some(
                (item: any) => item.type === 'session' && item.sessionId === 's1' && (item.storageKind ?? 'persisted') === 'direct',
            ),
        ).toBe(true);
    });

    it('preserves linked direct-session metadata when a later refresh sets externalSessionV1 to null', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadata: {
                    machineId: 'm1',
                    host: 'h1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'm1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'claudeConfigDir', configDir: '/tmp/claude' },
                    },
                },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: null,
                metadata: {
                    machineId: 'm1',
                    host: 'h1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    externalSessionV1: null,
                },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect((get().sessions.s1?.metadata as any)?.externalSessionV1).toEqual(expect.objectContaining({
            v: 1,
            agentId: 'claude',
            remoteSessionId: 'remote-1',
        }));
        expect(getSessionStorageKind(get().sessions.s1)).toBe('direct');
        expect(
            get().sessionListIndexByServerId['srv_active']?.some(
                (item: any) => item.type === 'session' && item.sessionId === 's1' && (item.storageKind ?? 'persisted') === 'direct',
            ),
        ).toBe(true);
    });

    it('does not rebuild the active-server sessionListIndex when updating a draft for a loaded session', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
    });

    it('does not resurrect a cleared draft when applySessions merges a loaded session update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);
        const saveWarmCache = warmCacheWrites;
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        domain.applySessions([
            currentSession({
                id: 's1',
                seq: 2,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                draft: 'server stale draft',
            } as any),
        ]);

        expect(get().sessions.s1?.draft).toBe('server stale draft');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(saveWarmCache).toHaveBeenCalledTimes(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('reuses the previous warm-cache renderable map when applySessions updates only one warm-cache relevant row', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

        observeSessionListWarmCacheWrites();
        vi.spyOn(warmCacheAdaptersModule, 'buildPersistedSessionListCacheEntriesFromRenderables');

        const warmCacheAdapters = await import('../../domains/state/warmCacheAdapters');

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
            currentSession({
                id: 's2',
                serverId: 'srv_active',
                seq: 2,
                createdAt: 2,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm2', path: '/home/u/repo-2', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const saveWarmCache = warmCacheWrites;
        const buildPreviousEntries = warmCacheAdapters.buildPersistedSessionListCacheEntriesFromRenderables as unknown as ReturnType<typeof vi.fn>;
        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);
        expect(saveWarmCache).toHaveBeenCalledTimes(1);

        const firstEntries = warmCachePersistence.peekSessionListWarmCacheEntries('srv_active', 'account_a');
        expect(firstEntries).toBeDefined();
        expect(saveWarmCache.mock.calls[0]?.[2]).toEqual(firstEntries);
        buildPreviousEntries.mockClear();

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
                pendingCount: 1,
                pendingVersion: 2,
            } as any),
        ]);

        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(saveWarmCache).toHaveBeenCalledTimes(2);
        expect(buildPreviousEntries.mock.calls.at(-1)?.[1]).toBe(firstEntries);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('does not rebuild the active-server sessionListIndex when marking optimistic thinking', async () => {

        observeSessionListWarmCacheWrites();

        const { get, domain } = createHarness();

        applyOrdinarySnapshot(domain, [
            currentSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        const initialIndex = get().sessionListIndexByServerId['srv_active'];
        expect(Array.isArray(initialIndex)).toBe(true);

        domain.markSessionOptimisticThinking('s1');
        expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
    });

    it('does not rewrite the warm cache for thinking-only applySessions updates', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

            observeSessionListWarmCacheWrites();

            const { get, domain } = createHarness();

            applyOrdinarySnapshot(domain, [
                currentSession({
                    id: 's1',
                    serverId: 'srv_active',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                } as any),
            ]);

            const saveWarmCache = warmCacheWrites;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            const initialIndex = get().sessionListIndexByServerId['srv_active'];

            domain.applySessions([
                currentSession({
                    id: 's1',
                    serverId: 'srv_active',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: true,
                    thinkingAt: 1,
                    presence: 1,
                } as any),
            ]);

            expect(get().sessions.s1?.thinking).toBe(true);
            expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('coalesces warm cache persistence for repeated applySessions cache-entry updates', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

            observeSessionListWarmCacheWrites();

            const { get, domain } = createHarness();

            const buildSession = (version: number, title: string) => (currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: version,
                createdAt: 1,
                updatedAt: version,
                active: true,
                activeAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/home/u/repo',
                    homeDir: '/home/u',
                    name: title,
                },
                metadataVersion: version,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any));

            applyOrdinarySnapshot(domain, [buildSession(1, 'Initial title')]);

            const saveWarmCache = warmCacheWrites;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            saveWarmCache.mockClear();

            domain.applySessions([buildSession(2, 'Updated title')]);
            domain.applySessions([buildSession(3, 'Final title')]);

            expect(get().sessions.s1?.metadata?.name).toBe('Final title');
            expect(saveWarmCache).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1_000);

            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            const entries = saveWarmCache.mock.calls.at(-1)?.[2] as Record<string, any>;
            expect(entries?.s1?.name).toBe('Final title');
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('coalesces warm cache writes for active streaming progress when list rows are stable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

            observeSessionListWarmCacheWrites();

            const { get, domain } = createHarness();

            applyOrdinarySnapshot(domain, [
                currentSession({
                    id: 'streaming',
                    serverId: 'srv_active',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: true,
                    thinkingAt: 1,
                    presence: 'online',
                } as any),
            ]);

            const saveWarmCache = warmCacheWrites;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            const initialIndex = get().sessionListIndexByServerId['srv_active'];
            expect(Array.isArray(initialIndex)).toBe(true);

            for (let index = 0; index < 10; index += 1) {
                domain.applySessions([
                    currentSession({
                        id: 'streaming',
                        serverId: 'srv_active',
                        seq: index + 2,
                        createdAt: 1,
                        updatedAt: index + 2,
                        active: true,
                        activeAt: index + 2,
                        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 0,
                        thinking: true,
                        thinkingAt: 1,
                        presence: 'online',
                    } as any),
                ]);
            }

            expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            vi.runOnlyPendingTimers();
            expect(saveWarmCache).toHaveBeenCalledTimes(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('cancels deferred warm cache writes when the session local state scope switches', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

            observeSessionListWarmCacheWrites();

            const { domain } = createHarness();

            applyOrdinarySnapshot(domain, [
                currentSession({
                    id: 'streaming',
                    serverId: 'srv_active',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: true,
                    thinkingAt: 1,
                    presence: 'online',
                } as any),
            ]);

            const saveWarmCache = warmCacheWrites;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);

            domain.applySessions([
                currentSession({
                    id: 'streaming',
                    serverId: 'srv_active',
                    seq: 2,
                    createdAt: 1,
                    updatedAt: 2,
                    active: true,
                    activeAt: 2,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: true,
                    thinkingAt: 1,
                    presence: 'online',
                } as any),
            ]);

            expect(saveWarmCache).toHaveBeenCalledTimes(1);

            domain.activateSessionLocalStateScope({ serverId: 'srv_active', accountId: 'account-b' });
            vi.runOnlyPendingTimers();

            expect(saveWarmCache).toHaveBeenCalledTimes(1);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('cancels deferred warm cache writes when the session local state scope clears', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

            observeSessionListWarmCacheWrites();

            const { domain } = createHarness();

            applyOrdinarySnapshot(domain, [
                currentSession({
                    id: 'streaming',
                    serverId: 'srv_active',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: true,
                    thinkingAt: 1,
                    presence: 'online',
                } as any),
            ]);

            const saveWarmCache = warmCacheWrites;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);

            domain.applySessions([
                currentSession({
                    id: 'streaming',
                    serverId: 'srv_active',
                    seq: 2,
                    createdAt: 1,
                    updatedAt: 2,
                    active: true,
                    activeAt: 2,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: true,
                    thinkingAt: 1,
                    presence: 'online',
                } as any),
            ]);

            expect(saveWarmCache).toHaveBeenCalledTimes(1);

            domain.clearSessionLocalStateScope();
            vi.runOnlyPendingTimers();

            expect(saveWarmCache).toHaveBeenCalledTimes(1);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('coalesces warm cache writes for active streaming progress during renderable replacement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        try {

            observeSessionListWarmCacheWrites();

            const { get, domain } = createHarness();

            const buildStreamingSession = (seq: number) => ({
                id: 'streaming',
                serverId: 'srv_active',
                seq,
                createdAt: 1,
                updatedAt: seq,
                active: true,
                activeAt: seq,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            } as any);

            applyOrdinarySnapshot(domain, [buildStreamingSession(1)]);

            const saveWarmCache = warmCacheWrites;
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            const initialIndex = get().sessionListIndexByServerId['srv_active'];
            expect(Array.isArray(initialIndex)).toBe(true);

            for (let seq = 2; seq <= 11; seq += 1) {
                replaceSessionListRows(domain, [
                    buildSessionListRenderableFromSession(buildStreamingSession(seq)),
                ]);
            }

            expect(get().sessionListIndexByServerId['srv_active']).toBe(initialIndex);
            expect(saveWarmCache).toHaveBeenCalledTimes(1);
            vi.runOnlyPendingTimers();
            expect(saveWarmCache).toHaveBeenCalledTimes(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('records applySessions telemetry when sync performance telemetry is enabled', async () => {

        observeSessionListWarmCacheWrites();

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');

        const { domain } = createHarness({
            ordinarySessionListMembershipByServerId: { srv_active: ['s1'] },
        });

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            domain.applySessions([
                currentSession({
                    id: 's1',
                    serverId: 'srv_active',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                } as any),
            ]);

            const event = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply');
            expect(event?.count).toBe(1);
            expect(event?.fields.sessions).toBe(1);

            const changedEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.changed');
            expect(changedEvent?.count).toBe(1);
            expect(changedEvent?.fields.changedSessions).toBe(1);
            expect(changedEvent?.fields.changedRenderables).toBe(1);
            expect(changedEvent?.fields.indexRebuild).toBe(1);
            expect(changedEvent?.fields.projectManagerUpdate).toBe(1);

            const firstApplyEvents = syncPerformanceTelemetry.snapshot().events;
            const mergeEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.merge');
            expect(mergeEvent?.count).toBe(1);
            expect(mergeEvent?.fields.sessions).toBe(1);
            const mergeOutcomeEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.merge.outcome');
            expect(mergeOutcomeEvent?.count).toBe(1);
            expect(mergeOutcomeEvent?.fields.changedSessions).toBe(1);
            expect(mergeOutcomeEvent?.fields.changedRenderables).toBe(1);
            expect(mergeOutcomeEvent?.fields.indexRebuild).toBe(1);
            expect(mergeOutcomeEvent?.fields.listViewFieldChanges).toBe(1);
            const indexRebuildEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.indexRebuild');
            expect(indexRebuildEvent?.count).toBe(1);
            expect(indexRebuildEvent?.fields.renderables).toBe(1);
            const projectManagerEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.projectManager');
            expect(projectManagerEvent?.count).toBe(1);
            expect(projectManagerEvent?.fields.sessions).toBe(1);
            const warmCacheEvent = firstApplyEvents.find((candidate) => candidate.name === 'sync.store.sessions.apply.warmCache');
            expect(warmCacheEvent?.count).toBe(1);
            expect(warmCacheEvent?.fields.renderables).toBe(1);

            domain.applySessions([
                currentSession({
                    id: 's1',
                    serverId: 'srv_active',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                } as any),
            ]);

            const noopEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.sessions.apply.noop');
            expect(noopEvent?.count).toBe(1);
            expect(noopEvent?.fields.sessions).toBe(1);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });

    it('publishes changed renderable ids from applySessions', async () => {

        observeSessionListWarmCacheWrites();

        const { domain, get } = createHarness({
            ordinarySessionListMembershipByServerId: { srv_active: ['s1'] },
        });

        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any),
        ]);

        expect(get().sessionListRenderableDelta).toEqual({
            revision: 1,
            changedSessionIds: ['s1'],
            removedSessionIds: [],
            rebuiltSessionListIndex: true,
        });

        const firstDelta = get().sessionListRenderableDelta;
        domain.applySessions([
            currentSession({
                id: 's1',
                serverId: 'srv_active',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                metadataVersion: 1,
                agentState: { requests: {} },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any),
        ]);

        expect(get().sessionListRenderableDelta).toEqual({
            revision: 2,
            changedSessionIds: ['s1'],
            removedSessionIds: [],
            rebuiltSessionListIndex: false,
        });
        expect(get().sessionListRenderableDelta).not.toBe(firstDelta);
    });
});

describe('sessions domain: qualified rows and ordinary membership', () => {
    it('does not promote an exact or query-only hydrated row into ordinary membership', async () => {

        observeSessionListWarmCacheWrites();

        const queryOnlySession: Session = currentSession({
            id: 'query-only',
            serverId: 'srv_active',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', path: '/query', host: 'host' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        });
        const queryOnly = buildSessionListRenderableFromSession(queryOnlySession);
        const { domain, get } = createHarness({
            sessionListRowsByServerId: { 'srv_active': { 'query-only': queryOnly } },
            ordinarySessionListMembershipByServerId: { 'srv_active': [] },
            archivedSessionListMembershipByServerId: {},
            sessionListIndexByServerId: { 'srv_active': [] },
        });

        domain.applySessions([{
            ...queryOnlySession,
            seq: 2,
            updatedAt: 2,
            metadata: { path: '/repo', host: 'test', ...queryOnlySession.metadata, name: 'Hydrated exact result' },
        }]);

        expect(get().sessions['query-only']).toEqual(expect.objectContaining({
            id: 'query-only',
            updatedAt: 2,
        }));
        expect(get().sessionListRowsByServerId['srv_active']['query-only']).toEqual(expect.objectContaining({
            id: 'query-only',
            updatedAt: 2,
        }));
        expect(get().ordinarySessionListMembershipByServerId['srv_active']).toEqual([]);
        expect(readSessionListIndexSessionIds(get().sessionListIndexByServerId['srv_active'])).toEqual([]);
    });

    it('keeps query-only rows out of the ordinary list corpus', async () => {

        observeSessionListWarmCacheWrites();

        const { domain, get } = createHarness({
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
        });
        const queryOnly = buildSessionListRenderableFromSession(currentSession({
            id: 'query-only',
            serverId: 'srv_a',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', path: '/query', host: 'host' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as Session));
        const ordinary = buildSessionListRenderableFromSession({
            ...queryOnly,
            id: 'ordinary',
            metadata: { machineId: 'm1', path: '/ordinary', host: 'host' },
        } as Session);

        domain.applyServerScopedSessionListRows('srv_a', [queryOnly], {
            source: 'rowOnly',
            mode: 'replace',
        });

        expect(get().sessionListRowsByServerId['srv_a']).toEqual({
            'query-only': queryOnly,
        });
        expect(get().ordinarySessionListMembershipByServerId['srv_a']).toBeUndefined();
        expect(get().archivedSessionListMembershipByServerId['srv_a']).toBeUndefined();
        expect(get().sessionListIndexByServerId['srv_a']).toBeUndefined();

        domain.applyServerScopedSessionListRows('srv_a', [ordinary], {
            source: 'ordinary',
            mode: 'replace',
        });

        expect(get().sessionListRowsByServerId['srv_a']).toEqual({
            'query-only': queryOnly,
            ordinary,
        });
        expect(get().ordinarySessionListMembershipByServerId['srv_a']).toEqual(['ordinary']);
        expect(readSessionListIndexSessionIds(get().sessionListIndexByServerId['srv_a'])).toEqual(['ordinary']);
    });

    it('never lets an ad-hoc row-only read publish the ordinary list index', async () => {

        observeSessionListWarmCacheWrites();

        // Ordinary membership already exists, but its index has not been built yet — the state a
        // Home reaches after rehydration before its list owner runs.
        const { domain, get } = createHarness({
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: { 'srv_a': ['ordinary'] },
            sessionListIndexByServerId: {},
        });
        const adHoc = buildSessionListRenderableFromSession(currentSession({
            id: 'ad-hoc',
            serverId: 'srv_a',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', path: '/ad-hoc', host: 'host' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as Session));

        domain.applyServerScopedSessionListRows('srv_a', [adHoc], {
            source: 'rowOnly',
            mode: 'replace',
        });

        // The row is hydrated for the command that asked for it, and nothing else moves: a Voice
        // or Action read owns no corpus, so it cannot publish a visible list either (L07-I35).
        expect(get().sessionListRowsByServerId['srv_a']).toEqual({ 'ad-hoc': adHoc });
        expect(get().ordinarySessionListMembershipByServerId['srv_a']).toEqual(['ordinary']);
        expect(get().sessionListIndexByServerId['srv_a']).toBeUndefined();
    });

    it('rebuilds the ordinary projection when a scoped hydration patch changes a member row', async () => {

        observeSessionListWarmCacheWrites();

        const { domain, get } = createHarness({
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
        });
        const ordinary = buildSessionListRenderableFromSession(currentSession({
            id: 'ordinary',
            serverId: 'srv_a',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: { machineId: 'm1', path: '/ordinary', host: 'host' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as Session));
        domain.applyServerScopedSessionListRows('srv_a', [ordinary], {
            source: 'ordinary',
            mode: 'replace',
        });
        expect(get().sessionListIndexByServerId['srv_a']?.find(
            (item: SessionListIndexItem) => item.type === 'session',
        )?.section).toBe('active');

        domain.applyServerScopedSessionListRowPatches('srv_a', [{
            sessionId: 'ordinary',
            patch: { active: false, activeAt: 2, presence: 2 },
        }]);

        expect(get().sessionListRowsByServerId['srv_a'].ordinary.active).toBe(false);
        expect(get().sessionListIndexByServerId['srv_a']?.find(
            (item: SessionListIndexItem) => item.type === 'session',
        )?.section).toBe('inactive');
    });

    it('owns archived membership separately from ordinary membership and preserves shared rows', async () => {

        observeSessionListWarmCacheWrites();

        const { domain, get } = createHarness({
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            archivedSessionListMembershipByServerId: {},
        });
        const archivedA = buildSessionListRenderableFromSession(currentSession({
            id: 'archived-a',
            serverId: 'srv_a',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 1,
            archivedAt: 2,
            metadata: { machineId: 'm1', path: '/archived-a', host: 'host' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as Session));
        const archivedB = buildSessionListRenderableFromSession({
            ...archivedA,
            id: 'archived-b',
            updatedAt: 3,
            archivedAt: 3,
            metadata: { machineId: 'm1', path: '/archived-b', host: 'host' },
        } as Session);

        expect(get().archivedSessionListMembershipByServerId['srv_a']).toBeUndefined();
        domain.applyServerScopedSessionListRows('srv_a', [archivedA], {
            source: 'archived',
            mode: 'replace',
        });
        domain.applyServerScopedSessionListRows('srv_a', [archivedA, archivedB], {
            source: 'archived',
            mode: 'append',
        });

        expect(get().archivedSessionListMembershipByServerId['srv_a']).toEqual([
            'archived-a',
            'archived-b',
        ]);
        expect(get().ordinarySessionListMembershipByServerId['srv_a']).toBeUndefined();
        const retainedRows = get().sessionListRowsByServerId['srv_a'];

        domain.applyServerScopedSessionListRows('srv_a', [], {
            source: 'archived',
            mode: 'replace',
        });
        expect(get().archivedSessionListMembershipByServerId['srv_a']).toEqual([]);
        expect(get().sessionListRowsByServerId['srv_a']).toBe(retainedRows);

        domain.applyServerScopedSessionListRows('srv_a', [archivedA, archivedB], {
            source: 'archived',
            mode: 'replace',
        });
        domain.applyServerScopedSessionListRows('srv_a', [{
            ...archivedA,
            updatedAt: 4,
            archivedAt: null,
        }], {
            source: 'ordinary',
            mode: 'append',
        });

        expect(get().archivedSessionListMembershipByServerId['srv_a']).toEqual(['archived-b']);
        expect(get().ordinarySessionListMembershipByServerId['srv_a']).toEqual(['archived-a']);
        expect(get().sessionListRowsByServerId['srv_a']['archived-a']?.archivedAt).toBeNull();
    });
});

/**
 * Lane 07 R18 / 07.5 §12 Packet D measurement at the canonical row-ingestion
 * and index owners: three Homes of fifty loaded rows. It records ingestion,
 * rebuild and rapid-change cost and proves that one Home's change leaves the
 * other Homes' index references untouched. Timings are recorded, never
 * asserted, and no cache or memoization is introduced here.
 */
describe('sessions domain: three-Home ingestion and index rebuild cost', () => {
    const HOME_COUNT = 3;
    const ROWS_PER_HOME = 50;
    const homeServerIds = Array.from({ length: HOME_COUNT }, (_, home) => `ingestion-home-${home}`);

    function buildHomeRows(home: number): SessionListRenderableSession[] {
        return Array.from({ length: ROWS_PER_HOME }, (_, index) => buildSessionListRenderableFromSession(currentSession({
            id: `ingestion-session-${home}-${index}`,
            serverId: homeServerIds[home],
            seq: index,
            createdAt: 1_000 + index,
            updatedAt: 1_000 + index,
            active: true,
            activeAt: 1_000 + index,
            archivedAt: null,
            metadata: { machineId: `m-${home}`, path: `/repo-${home}/project-${index % 5}`, host: 'host' },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as Session)));
    }

    it('keeps unrelated Home indexes referentially stable across ingestion, patches and rapid changes', async () => {

        observeSessionListWarmCacheWrites();

        const { domain, get, getSetCalls } = createHarness({
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
        });

        const ingestStartedAt = performance.now();
        const setCallsBeforeIngest = getSetCalls();
        for (let home = 0; home < HOME_COUNT; home += 1) {
            domain.applyServerScopedSessionListRows(homeServerIds[home], buildHomeRows(home), {
                source: 'ordinary',
                mode: 'replace',
            });
        }
        const ingestMs = performance.now() - ingestStartedAt;
        const ingestSetCalls = getSetCalls() - setCallsBeforeIngest;

        for (const serverId of homeServerIds) {
            expect(get().ordinarySessionListMembershipByServerId[serverId]).toHaveLength(ROWS_PER_HOME);
            expect(readSessionListIndexSessionIds(get().sessionListIndexByServerId[serverId]))
                .toHaveLength(ROWS_PER_HOME);
        }

        const indexesAfterIngest = Object.fromEntries(
            homeServerIds.map((serverId) => [serverId, get().sessionListIndexByServerId[serverId]]),
        );

        const patchedServerId = homeServerIds[1];
        const patchedSessionId = `ingestion-session-1-17`;

        const nonStructuralStartedAt = performance.now();
        patchActiveSessionListRows(domain, []);
        domain.applyServerScopedSessionListRowPatches(patchedServerId, [{
            sessionId: patchedSessionId,
            patch: { latestTurnStatus: 'completed', latestTurnStatusObservedAt: 4_000 },
        }]);
        const nonStructuralPatchMs = performance.now() - nonStructuralStartedAt;

        for (const serverId of homeServerIds) {
            expect(get().sessionListIndexByServerId[serverId]).toBe(indexesAfterIngest[serverId]);
        }
        expect(get().sessionListRowsByServerId[patchedServerId][patchedSessionId]?.latestTurnStatus)
            .toBe('completed');

        const structuralStartedAt = performance.now();
        domain.applyServerScopedSessionListRowPatches(patchedServerId, [{
            sessionId: patchedSessionId,
            patch: { metadata: { machineId: 'm-1', path: '/repo-1/moved-project', host: 'host' } },
        }]);
        const structuralPatchMs = performance.now() - structuralStartedAt;

        expect(get().sessionListIndexByServerId[patchedServerId]).not.toBe(indexesAfterIngest[patchedServerId]);
        for (const serverId of homeServerIds.filter((candidate) => candidate !== patchedServerId)) {
            expect(get().sessionListIndexByServerId[serverId]).toBe(indexesAfterIngest[serverId]);
        }

        const RAPID_CHANGE_COUNT = 20;
        const rapidStartedAt = performance.now();
        const setCallsBeforeRapidChanges = getSetCalls();
        for (let change = 0; change < RAPID_CHANGE_COUNT; change += 1) {
            domain.applyServerScopedSessionListRowPatches(patchedServerId, [{
                sessionId: patchedSessionId,
                patch: { seq: 2_000 + change, updatedAt: 5_000 + change },
            }]);
        }
        const rapidChangeMs = performance.now() - rapidStartedAt;
        const rapidChangeSetCalls = getSetCalls() - setCallsBeforeRapidChanges;

        for (const serverId of homeServerIds.filter((candidate) => candidate !== patchedServerId)) {
            expect(get().sessionListIndexByServerId[serverId]).toBe(indexesAfterIngest[serverId]);
        }
        expect(readSessionListIndexSessionIds(get().sessionListIndexByServerId[patchedServerId]))
            .toHaveLength(ROWS_PER_HOME);

        console.info([
            'Lane07 R18 UI ingestion/index cost:',
            `${HOME_COUNT} Homes x ${ROWS_PER_HOME} rows = ${HOME_COUNT * ROWS_PER_HOME} loaded rows`,
            `ingest ${ingestMs.toFixed(1)} ms in ${ingestSetCalls} store writes`,
            `non-structural patch ${nonStructuralPatchMs.toFixed(1)} ms (no index rebuild)`,
            `structural patch ${structuralPatchMs.toFixed(1)} ms (one Home rebuilt)`,
            `${RAPID_CHANGE_COUNT} rapid patches ${rapidChangeMs.toFixed(1)} ms in ${rapidChangeSetCalls} store writes`,
            `platform ${process.platform}/${process.arch}`,
        ].join(', '));
    });
});


describe('shared archive admission', () => {
    it('admits uncached exact-Home operations once without notifying duplicate callers', () => {
        const { domain, get, getSetCalls } = createHarness();
        const first = domain.beginSessionArchive({ sessionId: 'same', serverId: 'home-a' });
        expect(first).toEqual({ sessionId: 'same', serverId: 'home-a' });
        const notifications = getSetCalls();
        expect(domain.beginSessionArchive({ sessionId: 'same', serverId: 'home-a' })).toBeNull();
        expect(getSetCalls()).toBe(notifications);
        const other = domain.beginSessionArchive({ sessionId: 'same', serverId: 'home-b' });
        expect(other).not.toBeNull();
        domain.finishSessionArchive(first!);
        expect(get().sessionArchiveOperations['home-a']).toBeUndefined();
        expect(get().sessionArchiveOperations['home-b']?.same).toBe(other);
    });

    it('preserves operations on Home focus changes and ignores stale completion after account retirement', () => {
        const { domain, get, set } = createHarness();
        const original = domain.beginSessionArchive({ sessionId: 'same', serverId: 'home-a' });
        domain.activateSessionLocalStateScope({ serverId: 'home-b', accountId: 'account-b' });
        expect(get().sessionArchiveOperations['home-a']?.same).toBe(original);
        set({ sessionArchiveOperations: {} });
        const replacement = domain.beginSessionArchive({ sessionId: 'same', serverId: 'home-a' });
        domain.finishSessionArchive(original!);
        expect(get().sessionArchiveOperations['home-a']?.same).toBe(replacement);
        domain.finishSessionArchive(replacement!);
        expect(get().sessionArchiveOperations).toEqual({});
    });
});
