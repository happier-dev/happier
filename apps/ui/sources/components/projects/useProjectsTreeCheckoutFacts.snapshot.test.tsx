import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { renderHook, standardCleanup, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { projectLastMobileSurfaceState } from '@/sync/domains/state/navigationUiState';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { projectsTreeCheckoutKey } from './projectsTreeRows';
import { useProjectsTreeCheckoutFactsFor, useProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => {
    standardCleanup();
    projectManager.clear();
    replacePersistentUiStateForTest(projectLastMobileSurfaceState, {});
    vi.useRealTimers();
});

it('retains checkout subscriptions across presentation and order changes and refreshes membership and opened facts', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000);
    const ref: WorkspaceRefV1 = { id: 'checkout', serverId: 'home-a', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const other: WorkspaceRefV1 = { ...ref, id: 'other', rootPath: '/other' };
    storage.setState({ sessions: {}, machines: {}, machineListByServerId: {},
        sessionListRowsByServerId: { 'home-a': { session: createSessionListRenderableSessionFixture({
            id: 'session', active: true, activeAt: 1_000, thinking: true, thinkingAt: 1_000,
            metadata: { machineId: 'machine', path: '/repo' },
        }) } },
        profileScope: { serverId: 'home-a', accountId: 'account-a' },
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    const hook = await renderHook((refs: readonly WorkspaceRefV1[]) => {
        const source = useProjectsTreeCheckoutFactsSource(refs);
        useProjectsTreeCheckoutFactsFor(source, [...source.getSnapshot().keys()]);
        return source;
    }, { initialProps: [ref, other] });
    const source = hook.getCurrent();
    const initial = source.getSnapshot();
    expect([...initial.values()][0]).toMatchObject({ attention: 'working', newFromSession: true });
    await hook.rerender([other, { ...ref, label: 'Renamed' }]);
    expect(hook.getCurrent()).toBe(source);
    expect(hook.getCurrent().getSnapshot()).toBe(initial);
    await hook.rerender([other, { ...ref, lastOpenedAtMs: 1_000 }]);
    expect([...hook.getCurrent().getSnapshot().values()]).toMatchObject([
        { attention: null, newFromSession: false }, { attention: 'working', newFromSession: false },
    ]);
    await hook.rerender([{ ...ref, lastOpenedAtMs: 1_000 }]);
    expect([...hook.getCurrent().getSnapshot().values()]).toMatchObject([{ attention: 'working', newFromSession: false }]);
    await hook.rerender([other]);
    expect([...hook.getCurrent().getSnapshot().values()]).toMatchObject([{ attention: null, newFromSession: false }]);
    await hook.rerender([]);
    expect(hook.getCurrent().getSnapshot().size).toBe(0);
    await hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('serves 150 subscribed checkout readers without recomputing the shared inventory per snapshot read', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000);
    storage.setState({ sessions: {}, sessionListRowsByServerId: {}, machines: {}, machineListByServerId: {},
        profileScope: { serverId: 'home-a', accountId: 'account-a' },
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    let inventoryReads = 0;
    const refs: readonly WorkspaceRefV1[] = Array.from({ length: 150 }, (_, index) => ({
        id: `qf37-${index}`, machineId: 'machine', rootPath: `/repo-${index}`, createdAtMs: 1,
        get serverId() { inventoryReads += 1; return 'home-a'; },
    }));
    const keys = [projectsTreeCheckoutKey({ refId: refs[0]!.id,
        workspaceAddress: { serverId: 'home-a', workspaceId: refs[0]!.id, machineId: 'machine', rootPath: '/repo-0' } })];
    const hook = await renderHook(() => {
        const source = useProjectsTreeCheckoutFactsSource(refs);
        useProjectsTreeCheckoutFactsFor(source, keys);
        return source;
    });
    const source = hook.getCurrent();
    const published = source.getSnapshot();
    inventoryReads = 0;
    for (const _ref of refs) expect(source.getSnapshot()).toBe(published);
    expect(inventoryReads).toBe(0);
    await hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('does no inventory work for unrelated arrivals while real Session and SCM facts update only changed checkout identities', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000);
    const row = createSessionListRenderableSessionFixture({ id: 'session', active: true, activeAt: 1_000,
        thinking: true, thinkingAt: 1_000, metadata: { machineId: 'machine', path: '/repo-0' } });
    const rows = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`other-${index}`,
        createSessionListRenderableSessionFixture({ id: `other-${index}`,
            metadata: { machineId: 'machine', path: `/outside-${index}` } })]));
    storage.setState({ sessions: {}, sessionListRowsByServerId: { 'home-a': rows }, machines: {}, machineListByServerId: {},
        profileScope: { serverId: 'home-a', accountId: 'account-a' },
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    let inventoryReads = 0;
    const checkoutReads = new Set<number>();
    const refs: readonly WorkspaceRefV1[] = Array.from({ length: 150 }, (_, index) => ({
        id: `qp1-${index}`, machineId: 'machine', rootPath: `/repo-${index}`, createdAtMs: 1,
        get serverId() { inventoryReads += 1; checkoutReads.add(index); return 'home-a'; },
    }));
    const hook = await renderHook(() => useProjectsTreeCheckoutFactsSource(refs));
    const source = hook.getCurrent();
    let publications = 0;
    const stop = source.subscribe(() => { publications++; });
    onTestFinished(stop);
    const before = source.getSnapshot();
    inventoryReads = 0;
    publications = 0;
    for (let arrival = 0; arrival < 5; arrival++) {
        storage.setState({ sessionLastViewed: { 'unrelated-session': 1_001 + arrival } });
    }
    expect(source.getSnapshot()).toBe(before);
    expect(inventoryReads).toBe(0);
    expect(publications).toBe(0);

    const publishRow = (next: typeof row, revision: number) => storage.setState({
        sessionListRowsByServerId: { 'home-a': { ...rows, session: next } },
        sessionListRenderableDelta: { revision, changedSessionIds: ['session'], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    const changedIndices = (previous: typeof before) => {
        const baseline = [...previous.values()];
        return [...source.getSnapshot().values()].flatMap((fact, index) => fact === baseline[index] ? [] : [index]);
    };
    publishRow(row, 1);
    expect([...source.getSnapshot().values()][0]).toMatchObject({ attention: 'working', newFromSession: true });
    expect(changedIndices(before)).toEqual([0]);
    const working = source.getSnapshot();
    publishRow({ ...row, seq: row.seq + 1 }, 2);
    expect(source.getSnapshot()).toBe(working);
    expect(publications).toBe(1);
    publishRow({ ...row, metadata: { ...row.metadata, path: '/repo-1' } }, 3);
    expect([...source.getSnapshot().values()].slice(0, 2)).toMatchObject([
        { attention: null, newFromSession: false }, { attention: 'working', newFromSession: true },
    ]);
    expect(changedIndices(working)).toEqual([0, 1]);

    const moved = source.getSnapshot();
    let sessionCensusScans = 0;
    // Observe inventory enumeration at the real store boundary; keep every row and selector real.
    const currentRows = storage.getState().sessionListRowsByServerId['home-a']!;
    storage.setState({ sessionListRowsByServerId: { 'home-a': new Proxy(currentRows, {
        ownKeys(target) { sessionCensusScans++; return Reflect.ownKeys(target); },
    }) } });
    expect(source.getSnapshot()).toBe(moved);
    sessionCensusScans = 0;
    const snapshot: ScmWorkingSnapshot = {
        projectKey: 'runtime-only', fetchedAt: 1_000,
        repo: { isRepo: true, rootPath: '/repo-42' },
        branch: { head: 'feature', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    };
    const scmScope = { serverId: 'home-a', machineId: 'machine', rootPath: '/repo-42' };
    checkoutReads.clear();
    storage.getState().updateWorkspaceScmSnapshot(scmScope, snapshot);
    expect([...source.getSnapshot().values()][42]?.branch).toBe('feature');
    expect(changedIndices(moved)).toEqual([42]);
    expect([...checkoutReads]).toEqual([42]);
    expect(sessionCensusScans).toBe(0);
    const branched = source.getSnapshot();
    inventoryReads = 0;
    storage.getState().updateWorkspaceScmSnapshot(scmScope, { ...snapshot, fetchedAt: 1_001 });
    expect(inventoryReads).toBe(0);
    checkoutReads.clear();
    storage.getState().updateWorkspaceScmSnapshot(scmScope, { ...snapshot, totals: { ...snapshot.totals, untrackedFiles: 1 } });
    expect(source.getSnapshot()).toBe(branched);
    expect([...checkoutReads]).toEqual([42]);
    expect(sessionCensusScans).toBe(0);
    expect(publications).toBe(3);
    checkoutReads.clear();
    storage.getState().updateWorkspaceScmSnapshot({ ...scmScope, rootPath: '/unmounted' }, snapshot);
    expect(checkoutReads.size).toBe(0);
    expect(sessionCensusScans).toBe(0);
    expect(source.getSnapshot()).toBe(branched);
    checkoutReads.clear();
    storage.setState({
        sessionListRowsByServerId: { 'home-a': { ...storage.getState().sessionListRowsByServerId['home-a'],
            'other-42': { ...rows['other-42']!, seq: rows['other-42']!.seq + 1 },
        } },
        sessionListRenderableDelta: { revision: 4, changedSessionIds: ['other-42'], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    expect(source.getSnapshot()).toBe(branched);
    expect(checkoutReads.size).toBe(0);
    storage.getState().updateWorkspaceScmSnapshot(scmScope, null);
    expect(source.getSnapshot()).toEqual(moved);
    expect(changedIndices(branched)).toEqual([42]);
    stop();
    inventoryReads = 0;
    storage.getState().updateWorkspaceScmSnapshot(scmScope, snapshot);
    expect(inventoryReads).toBe(0);
    const resumed = source.subscribe(() => {});
    onTestFinished(resumed);
    expect([...source.getSnapshot().values()][42]?.branch).toBe('feature');
    resumed();
    await hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('reads current freshness when the shared source is consumed again after its last reader leaves', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000);
    const refs: readonly WorkspaceRefV1[] = [{ id: 'qf37-resume', serverId: 'home-a', machineId: 'machine',
        rootPath: '/repo-resume', createdAtMs: 1 }];
    const row = createSessionListRenderableSessionFixture({ id: 'qf37-live', active: true, activeAt: 1_000,
        thinking: true, thinkingAt: 1_000, metadata: { machineId: 'machine', path: '/repo-resume' } });
    storage.setState({ sessions: {}, machines: {}, machineListByServerId: {},
        sessionListRowsByServerId: { 'home-a': { 'qf37-live': row } },
        profileScope: { serverId: 'home-a', accountId: 'account-a' },
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    const hook = await renderHook(() => useProjectsTreeCheckoutFactsSource(refs));
    const source = hook.getCurrent();
    const unsubscribe = source.subscribe(() => {});
    expect([...source.getSnapshot().values()][0]?.attention).toBe('working');
    unsubscribe();
    vi.setSystemTime(200_000);
    expect([...source.getSnapshot().values()][0]?.attention).toBeNull();
    await hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('discovers a Session subdirectory root and keeps root changes, removal, Account switch and resumed demand current', async () => {
    const nowMs = Date.now();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(nowMs);
    const refs: readonly WorkspaceRefV1[] = ['/repo', '/other'].map((rootPath, index) => ({
        id: `discovery-${index}`, serverId: 'home-a', machineId: 'machine', rootPath, createdAtMs: 1,
    }));
    const row = createSessionListRenderableSessionFixture({ id: 'nested', active: true, activeAt: nowMs,
        thinking: true, thinkingAt: nowMs, metadata: { machineId: 'machine', path: '/repo/nested' } });
    storage.setState({ sessions: {}, machines: {}, machineListByServerId: {}, machineListStatusByServerId: {},
        sessionListRowsByServerId: { 'home-a': {} },
        profileScope: { serverId: 'home-a', accountId: 'account-a' },
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    const hook = await renderHook(() => useProjectsTreeCheckoutFactsSource(refs));
    const source = hook.getCurrent();
    let stop = source.subscribe(() => {});
    onTestFinished(() => stop());
    const facts = () => [...source.getSnapshot().values()];
    expect(facts().map(fact => fact.attention)).toEqual([null, null]);
    storage.setState({ sessionListRowsByServerId: { 'home-a': { nested: row } },
        sessionListRenderableDelta: { revision: 1, changedSessionIds: ['nested'], removedSessionIds: [], rebuiltSessionListIndex: false },
    });
    expect(facts().map(fact => fact.attention)).toEqual([null, null]);
    const nestedScope = { serverId: 'home-a', machineId: 'machine', rootPath: '/repo/nested' };
    const snapshot: ScmWorkingSnapshot = {
        projectKey: 'runtime-only', fetchedAt: nowMs,
        repo: { isRepo: true, rootPath: '/repo', worktrees: [{ path: '/repo', isMain: false, isCurrent: true, branch: 'feature' }] },
        branch: { head: 'feature', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    };
    storage.getState().updateWorkspaceScmSnapshot(nestedScope, snapshot);
    expect(facts()[0]).toMatchObject({ branch: 'feature', isWorktree: true, attention: 'working', newFromSession: true });
    storage.getState().updateWorkspaceScmSnapshot(nestedScope, { ...snapshot, repo: { isRepo: true, rootPath: '/other' },
        branch: { ...snapshot.branch, head: 'moved' } });
    expect(facts()).toMatchObject([{ branch: null, attention: null }, { branch: 'moved', attention: 'working' }]);
    storage.getState().updateWorkspaceScmSnapshot(nestedScope, null);
    expect(facts()).toMatchObject([{ branch: null, attention: null }, { branch: null, attention: null }]);
    storage.getState().updateWorkspaceScmSnapshot(nestedScope, snapshot);
    projectManager.clear();
    expect(facts()[0]).toMatchObject({ branch: null, attention: null });
    storage.getState().updateWorkspaceScmSnapshot(nestedScope, snapshot);
    const accountBScope = { serverId: 'home-a', accountId: 'account-b' };
    const accountBKey = buildRealmQualifiedMobileSurfaceStorageKey('project', accountBScope, refs[0]!.id)!;
    projectLastMobileSurfaceState.set(accountBKey, 'code');
    expect(facts()[0]?.newFromSession).toBe(true);
    storage.setState({ profileScope: accountBScope });
    expect(facts()[0]).toMatchObject({ branch: 'feature', newFromSession: false });
    const accountAKey = buildRealmQualifiedMobileSurfaceStorageKey('project', {
        serverId: 'home-a', accountId: 'account-a',
    }, refs[0]!.id)!;
    const switched = source.getSnapshot();
    projectLastMobileSurfaceState.set(accountAKey, 'code');
    expect(source.getSnapshot()).toBe(switched);
    projectLastMobileSurfaceState.remove(accountBKey);
    expect(facts()[0]?.newFromSession).toBe(true);
    projectManager.clear();
    storage.setState({ sessions: {}, sessionListRowsByServerId: {},
        profileScope: { serverId: 'home-a', accountId: 'account-b' },
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: true },
    });
    expect(facts()).toMatchObject([{ branch: null, attention: null, newFromSession: false }, { branch: null, attention: null }]);
    stop();
    storage.getState().updateWorkspaceScmSnapshot(refs[0]!, snapshot);
    stop = source.subscribe(() => {});
    expect(facts()[0]?.branch).toBe('feature');
    stop();
    await hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
});
