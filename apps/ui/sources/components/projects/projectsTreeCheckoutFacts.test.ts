import { afterEach, describe, expect, it } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { createProjectsTreeCheckoutFactsSelector, type ProjectsTreeCheckoutFactsState } from './projectsTreeCheckoutFacts';
import { projectsTreeCheckoutKey } from './projectsTreeRows';

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
    sessions: {}, machines: {}, machineListByServerId: {},
    sessionListRowsByServerId: {}, profileScope: { serverId: 'home-a', accountId: 'account-a' },
    localSettings: { projectLastMobileSurfaceByWorkspaceRefId: {} },
    getWorkspaceScmSnapshot: scope => projectManager.getWorkspaceScmSnapshot(scope),
});

afterEach(() => projectManager.clear());

describe('Projects tree checkout facts', () => {
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
        source = { ...source, localSettings: { projectLastMobileSurfaceByWorkspaceRefId: { [storageKey]: 'code' } } };
        expect([...select(source, 1_100).values()][0]).toMatchObject({ newFromSession: false });
        expect([...select(source, 121_001).values()][0]).toMatchObject({ attention: null });
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
