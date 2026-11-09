import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import { projectLastMobileSurfaceState } from '@/sync/domains/state/navigationUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { createProjectsTreeCheckoutFactsSelector, type ProjectsTreeCheckoutFactsState } from './projectsTreeCheckoutFacts';
import { buildProjectsTreeProjects, buildProjectsTreeRows, projectsTreeCheckoutKey } from './projectsTreeRows';

const ref = (id: string, serverId = 'home-a', rootPath = '/repo'): WorkspaceRefV1 => ({
    id, serverId, machineId: 'machine-1', rootPath, createdAtMs: 1,
});
const snapshot = (): ScmWorkingSnapshot => ({
    projectKey: 'runtime-only', fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/repo', worktrees: [{ path: '/repo', branch: 'feature', isCurrent: true, isMain: false }] },
    branch: { head: 'feature', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
        includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
});
const session = (id: string, extra: Parameters<typeof createSessionListRenderableSessionFixture>[0] = {}) => (
    createSessionListRenderableSessionFixture({ id, active: true, activeAt: 1_000, thinkingAt: 1_000,
        metadata: { machineId: 'machine-1', path: '/repo/nested' }, ...extra })
);
const state = (): ProjectsTreeCheckoutFactsState => ({
    sessions: {}, machines: {}, machineListByServerId: {}, machineListStatusByServerId: {},
    sessionListRowsByServerId: {}, profileScope: { serverId: 'home-a', accountId: 'account-a' },
    sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
    getWorkspaceScmSnapshot: scope => projectManager.getWorkspaceScmSnapshot(scope),
});

afterEach(() => {
    projectManager.clear();
    replacePersistentUiStateForTest(projectLastMobileSurfaceState, {});
});

describe('Projects tree checkout facts', () => {
    it('does not enumerate this Home for five row and Machine inventory arrivals on another Home', () => {
        const source = state();
        let scans = 0;
        source.sessionListRowsByServerId = { 'home-a': new Proxy({ own: session('own', {
            metadata: { machineId: 'machine-1', path: '/repo' }, latestTurnStatus: 'in_progress',
        }) }, {
            ownKeys(target) { scans++; return Reflect.ownKeys(target); },
        }) };
        const select = createProjectsTreeCheckoutFactsSelector([ref('workspace')]);
        const before = select(source, 1_100);
        expect([...before.values()][0]?.attention).toBe('working');
        scans = 0;
        for (let arrival = 0; arrival < 5; arrival++) {
            source.sessionListRowsByServerId = { ...source.sessionListRowsByServerId,
                'home-b': { other: session('other', { seq: arrival }) } };
            source.machineListByServerId = { ...source.machineListByServerId, 'home-b': [] };
            source.sessionListRenderableDelta = { revision: arrival + 1, changedSessionIds: ['other'],
                removedSessionIds: [], rebuiltSessionListIndex: true };
            expect(select(source, 1_100)).toBe(before);
        }
        expect(scans).toBe(0);
        source.sessionListRowsByServerId = { ...source.sessionListRowsByServerId,
            'home-a': { own: session('own', { metadata: { machineId: 'machine-1', path: '/repo' }, latestTurnStatus: 'completed' }) } };
        expect([...select(source, 1_100).values()][0]?.attention).toBeNull();
    });
    it('PF4 keeps equal checkout facts and changes only one of 150 checkout identities', () => {
        const refs = Array.from({ length: 150 }, (_, index) => ref(`checkout-${index}`, 'home-a', `/repo-${index}`));
        const source = state();
        const select = createProjectsTreeCheckoutFactsSelector(refs);
        const before = select(source, 1_100);
        let publications = 0;
        for (let arrival = 0; arrival < 5; arrival++) {
            const next = select({ ...source }, 1_101 + arrival);
            if (next !== before) publications++;
        }
        expect(publications).toBe(0);
        const checkout = refs[42];
        projectManager.updateWorkspaceScmSnapshot(checkout, { ...snapshot(), repo: { isRepo: true, rootPath: checkout.rootPath },
            branch: { ...snapshot().branch, head: 'changed' } });
        const after = select(source, 1_110, { scmScopeKey: buildWorkspaceCacheKey(checkout) });
        expect(after).not.toBe(before);
        const changed = [...after].filter(([key, value]) => value !== before.get(key));
        expect(changed).toHaveLength(1);
        expect(changed[0][1].branch).toBe('changed');
    });
    it('uses the viewer admission instead of promoting a quiet runtime permission into Needs you', () => {
        const source = state();
        const row = session('quiet', { metadata: { machineId: 'machine-1', path: '/repo' },
            hasPendingPermissionRequests: true, pendingRequestObservedAt: 1_000,
            viewer: { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
                follow: { follows: false, notificationLevel: null }, notification: { level: 'none', source: 'none' },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' } },
        });
        source.sessionListRowsByServerId = { 'home-a': { quiet: row } };
        const facts = createProjectsTreeCheckoutFactsSelector([ref('workspace')])(source, 1_100);
        expect([...facts.values()][0]?.attention).not.toBe('needs-you');
    });
    it('does not rescan Session placement when the store publishes unchanged selector inputs', () => {
        const source = state();
        source.getWorkspaceScmSnapshot = vi.fn(source.getWorkspaceScmSnapshot);
        const select = createProjectsTreeCheckoutFactsSelector([ref('workspace')]);
        const before = select(source, 1_100);
        const callsAfterFirstSelection = vi.mocked(source.getWorkspaceScmSnapshot).mock.calls.length;

        expect(select(source, 1_100)).toBe(before);
        expect(source.getWorkspaceScmSnapshot).toHaveBeenCalledTimes(callsAfterFirstSelection);
    });

    it('does not re-place a thousand Sessions for Machine heartbeats and daemon publications', () => {
        const refs = Array.from({ length: 100 }, (_, index) => ref(`workspace-${index}`, 'home-a', `/repo-${index}`));
        const rows = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`session-${index}`, session(`session-${index}`, {
            metadata: { machineId: 'machine-1', path: `/repo-${Math.floor(index / 10)}` },
        })]));
        const machine = createMachineFixture();
        const source = { ...state(), sessionListRowsByServerId: { 'home-a': rows },
            machines: { 'machine-1': machine }, machineListByServerId: { 'home-a': [machine] },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: true } };
        const readSnapshot = vi.fn(source.getWorkspaceScmSnapshot);
        source.getWorkspaceScmSnapshot = readSnapshot;
        const select = createProjectsTreeCheckoutFactsSelector(refs);
        const before = select(source, 1_100);
        readSnapshot.mockClear();
        let current: typeof source = source;
        for (let beat = 1; beat <= 5; beat++) {
            const next = { ...machine, activeAt: 1_000 + beat, updatedAt: 1_000 + beat,
                daemonStateVersion: 1 + beat, daemonState: { status: 'running', resources: { beat } } };
            current = { ...current, machines: { 'machine-1': next }, machineListByServerId: { 'home-a': [next] } };
            expect(select(current, 1_100)).toBe(before);
        }
        // No Session was re-placed: placement reads each Session's SCM snapshot.
        expect(readSnapshot).toHaveBeenCalledTimes(0);
        // A fact placement reads (the Machine's home directory) still re-places.
        const moved = { ...machine, metadata: { ...machine.metadata!, homeDir: '/Users/moved' } };
        select({ ...current, machines: { 'machine-1': moved }, machineListByServerId: { 'home-a': [moved] } }, 1_100);
        expect(readSnapshot.mock.calls.length).toBeGreaterThan(0);
    });

    it('recomputes only the changed checkout membership among a thousand admitted Sessions', () => {
        const refs = Array.from({ length: 100 }, (_, index) => ref(`workspace-${index}`, 'home-a', `/repo-${index}`));
        const rows = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`session-${index}`, session(`session-${index}`, {
            metadata: { machineId: 'machine-1', path: `/repo-${Math.floor(index / 10)}` }, latestTurnStatus: 'in_progress',
        })]));
        const source = { ...state(), sessionListRowsByServerId: { 'home-a': rows },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: true } };
        const readSnapshot = vi.fn(source.getWorkspaceScmSnapshot);
        source.getWorkspaceScmSnapshot = readSnapshot;
        const select = createProjectsTreeCheckoutFactsSelector(refs);
        const before = select(source, 1_100);
        readSnapshot.mockClear();
        const changed = { ...source, sessionListRowsByServerId: { 'home-a': { ...rows,
            'session-0': { ...rows['session-0']!, latestTurnStatus: 'completed' as const },
        } }, sessionListRenderableDelta: { revision: 2, changedSessionIds: ['session-0'], removedSessionIds: [], rebuiltSessionListIndex: false } };
        const after = select(changed, 1_100);
        // Ten members, one changed placement and one affected checkout; no other checkout reads.
        expect(readSnapshot.mock.calls.length).toBeLessThanOrEqual(12);
        expect([...after.values()].slice(1)).toEqual([...before.values()].slice(1));
        expect([...after.values()][99]).toBe([...before.values()][99]);
    });

    it('keeps a cached branch in an offline checkout row without a live Session', () => {
        const checkoutRef = ref('workspace');
        projectManager.updateWorkspaceScmSnapshot(checkoutRef, snapshot());
        const facts = createProjectsTreeCheckoutFactsSelector([checkoutRef])(state(), 1_100);
        const projects = buildProjectsTreeProjects({
            groups: [{ projectKey: { projectKey: 'project' }, items: [checkoutRef] }],
            projectName: () => 'Project',
            machine: () => ({ name: 'devbox', homeDir: null, online: false }),
            checkoutFacts: ref => facts.get(projectsTreeCheckoutKey({ refId: ref.id, workspaceAddress: {
                serverId: ref.serverId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath,
            } })) ?? null,
        });
        expect(projects[0]?.checkouts[0]).toMatchObject({ branch: 'feature', offline: true });
        expect(buildProjectsTreeRows({ projects, openRefId: null, expandedKeys: new Set() })[0])
            .toMatchObject({ subtitle: 'devbox · feature' });
    });

    it('re-places only the listed Sessions when the Session list index is rebuilt', () => {
        const refs = Array.from({ length: 100 }, (_, index) => ref(`workspace-${index}`, 'home-a', `/repo-${index}`));
        const rows = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`session-${index}`, session(`session-${index}`, {
            metadata: { machineId: 'machine-1', path: `/repo-${Math.floor(index / 10)}` }, latestTurnStatus: 'in_progress',
        })]));
        const source = { ...state(), sessionListRowsByServerId: { 'home-a': rows },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: true } };
        const readSnapshot = vi.fn(source.getWorkspaceScmSnapshot);
        source.getWorkspaceScmSnapshot = readSnapshot;
        const select = createProjectsTreeCheckoutFactsSelector(refs);
        select(source, 1_100);
        readSnapshot.mockClear();
        // A reordering activity write: one listed row changes and the index projection is rebuilt.
        const after = select({ ...source, sessionListRowsByServerId: { 'home-a': { ...rows,
            'session-0': { ...rows['session-0']!, latestTurnStatus: 'completed' as const } } },
        sessionListRenderableDelta: { revision: 2, changedSessionIds: ['session-0'], removedSessionIds: [], rebuiltSessionListIndex: true } }, 1_100);
        expect(readSnapshot.mock.calls.length).toBeLessThanOrEqual(12);
        expect([...after.values()][0]?.attention).toBe('working');
    });

    it('re-places Sessions listed as moved between Homes and removes only the addressed Home on a deletion', () => {
        const refs = [ref('first'), ref('second', 'home-b')];
        const row = session('same', { metadata: { machineId: 'machine-1', path: '/repo' }, latestTurnStatus: 'in_progress' });
        const initial = { ...state(), sessionListRowsByServerId: { 'home-a': { same: row }, 'home-b': { same: row } } };
        const select = createProjectsTreeCheckoutFactsSelector(refs);
        expect([...select(initial, 1_100).values()].map(fact => fact.attention)).toEqual(['working', 'working']);
        const removed = { ...initial, sessionListRowsByServerId: { 'home-a': {}, 'home-b': { same: row } },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: [], removedSessionIds: ['same'], rebuiltSessionListIndex: false } };
        expect([...select(removed, 1_100).values()].map(fact => fact.attention)).toEqual([null, 'working']);
        const reset = { ...removed, sessionListRowsByServerId: { 'home-a': { same: row }, 'home-b': {} },
            sessionListRenderableDelta: { revision: 2, changedSessionIds: ['same'], removedSessionIds: [], rebuiltSessionListIndex: true } };
        expect([...select(reset, 1_100).values()].map(fact => fact.attention)).toEqual(['working', null]);
    });

    it('projects nested accepted Session awareness through the canonical SCM root and keeps equal ids on another Home separate', () => {
        const refs = [ref('same-id'), ref('same-id', 'home-b')];
        const source = state();
        source.sessionListRowsByServerId = {
            'home-a': { work: session('work', { latestTurnStatus: 'in_progress' }),
                wait: session('wait', { latestTurnStatus: 'in_progress', hasPendingPermissionRequests: true, pendingRequestObservedAt: 1_000 }) },
            'home-b': { work: session('work', { latestTurnStatus: 'completed' }) },
        };
        for (const serverId of ['home-a', 'home-b']) projectManager.updateWorkspaceScmSnapshot({
            serverId, machineId: 'machine-1', rootPath: '/repo/nested',
        }, snapshot());
        const selected = createProjectsTreeCheckoutFactsSelector(refs)(source, 1_100);
        expect(selected.get(projectsTreeCheckoutKey({ refId: refs[0]!.id, workspaceAddress: {
            serverId: 'home-a', workspaceId: 'same-id', machineId: 'machine-1', rootPath: '/repo',
        } }))).toEqual({ branch: 'feature', isWorktree: true, attention: 'needs-you', newFromSession: true });
        expect(selected.get(projectsTreeCheckoutKey({ refId: refs[1]!.id, workspaceAddress: {
            serverId: 'home-b', workspaceId: 'same-id', machineId: 'machine-1', rootPath: '/repo',
        } }))).toEqual({ branch: 'feature', isWorktree: true, attention: null, newFromSession: false });
    });

    it('clears arrival through existing realm-qualified viewed memory and canonical terminal/freshness facts', () => {
        const refs = [ref('workspace')];
        let source = state();
        source.sessionListRowsByServerId = { 'home-a': { wait: session('wait', {
            metadata: { machineId: 'machine-1', path: '/repo' }, thinking: true,
            hasPendingPermissionRequests: true, pendingRequestObservedAt: 1_000,
        }) } };
        const select = createProjectsTreeCheckoutFactsSelector(refs);
        expect([...select(source, 1_100).values()][0]).toMatchObject({ attention: 'needs-you', newFromSession: true });
        const storageKey = buildRealmQualifiedMobileSurfaceStorageKey('project', source.profileScope!, 'workspace')!;
        projectLastMobileSurfaceState.set(storageKey, 'code');
        expect([...select(source, 1_100, { mobileSurfaceKey: storageKey }).values()][0]).toMatchObject({ newFromSession: false });
        // A pending request stays visible while its runtime is live, however long it has waited.
        expect([...select(source, 121_001).values()][0]).toMatchObject({ attention: 'needs-you' });
        source.sessionListRowsByServerId = { 'home-a': { wait: session('wait', {
            metadata: { machineId: 'machine-1', path: '/repo' }, thinking: true, latestTurnStatus: 'completed',
        }) } };
        expect([...select(source, 1_100).values()][0]).toMatchObject({ attention: null });
    });

    it('retains summary identities on unrelated Session changes and only replaces the checkout whose facts changed', () => {
        const refs = [ref('first'), ref('second', 'home-a', '/other')];
        const source = state();
        source.sessionListRowsByServerId = { 'home-a': { work: session('work', {
            metadata: { machineId: 'machine-1', path: '/repo' }, latestTurnStatus: 'in_progress',
        }) } };
        const select = createProjectsTreeCheckoutFactsSelector(refs);
        const before = select(source, 1_100);
        source.sessionListRowsByServerId = { 'home-a': { work: session('work', {
            metadata: { machineId: 'machine-1', path: '/repo', name: 'New title' }, latestTurnStatus: 'in_progress', seq: 100,
        }) } };
        expect(select(source, 1_100)).toBe(before);
        source.sessionListRowsByServerId = { 'home-a': { work: session('work', {
            metadata: { machineId: 'machine-1', path: '/repo' }, latestTurnStatus: 'completed',
        }) } };
        const after = select(source, 1_100);
        expect(after).not.toBe(before);
        expect([...after.values()][1]).toBe([...before.values()][1]);
    });
});
