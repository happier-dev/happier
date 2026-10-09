import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createProjectAccountRowsDomain, readProjectWorkspaceRefs, type ProjectAccountRowsDomain, type ProjectAccountRowsSnapshot } from './projectAccountRows';

const scope = { serverId: 'home-a', accountId: 'account-a' };
function snapshot(): ProjectAccountRowsSnapshot {
    return { scope, status: 'ready', coverage: 'complete', workspaceRefs: [
        { id: 'ref-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', createdAtMs: 1, projectKey: 'anchor' },
        { id: 'ref-b', serverId: 'home-a', machineId: 'machine-b', rootPath: '/repo', createdAtMs: 1, projectKey: 'anchor' },
    ], relationships: [], organizations: [{ key: { kind: 'project-organization', serverId: 'home-a', projectKey: 'anchor' }, revision: 1, value: { pinned: true } }], revisionsByPhysicalKey: {} };
}
function store() { return createStore<ProjectAccountRowsDomain>()((set, get) => createProjectAccountRowsDomain({ set, get })); }

describe('Project Account row projection', () => {
    it('isolates Home/Account switches and refuses responses for a retired scope', () => {
        const state = store();
        state.getState().activateProjectAccountRowsScope(scope);
        state.getState().applyProjectAccountRowsForScope(scope, snapshot());
        expect(state.getState().projectAccountRows?.workspaceRefs).toHaveLength(2);
        const nextScope = { serverId: 'home-b', accountId: 'account-a' };
        state.getState().activateProjectAccountRowsScope(nextScope);
        const before = state.getState();
        state.getState().applyProjectAccountRowsForScope(scope, snapshot());
        expect(state.getState()).toBe(before);
        expect(state.getState().projectAccountRows?.scope).toEqual(nextScope);
        expect(state.getState().projectAccountRows?.coverage).toBe('unknown');
        expect(state.getState().projectAccountRows?.workspaceRefs).toEqual([]);
    });
    it('retains hydrated rows on refresh failure and suppresses identical snapshots in a real Zustand store', () => {
        const state = store();
        state.getState().activateProjectAccountRowsScope(scope);
        state.getState().applyProjectAccountRowsForScope(scope, snapshot());
        const ready = state.getState();
        let notifications = 0;
        const unsubscribe = state.subscribe(() => notifications++);
        state.getState().applyProjectAccountRowsForScope(scope, structuredClone(snapshot()));
        expect(state.getState()).toBe(ready);
        expect(notifications).toBe(0);
        state.getState().setProjectAccountRowsStatusForScope(scope, 'error');
        expect(state.getState().projectAccountRows?.workspaceRefs).toBe(ready.projectAccountRows?.workspaceRefs);
        expect(state.getState().projectAccountRows?.coverage).toBe('complete');
        unsubscribe();
    });
    it('projects pins from stable Project anchors and preserves independent ref identities when only organization changes', () => {
        const state = store();
        state.getState().activateProjectAccountRowsScope(scope);
        state.getState().applyProjectAccountRowsForScope(scope, snapshot());
        const ready = state.getState();
        expect(ready.pinnedWorkspaceRefIds).toEqual(['ref-a', 'ref-b']);
        const unpinned = snapshot();
        unpinned.organizations[0]!.value.pinned = false;
        state.getState().applyProjectAccountRowsForScope(scope, unpinned);
        expect(state.getState().pinnedWorkspaceRefIds).toEqual([]);
        expect(state.getState().projectAccountRows?.workspaceRefs).toBe(ready.projectAccountRows?.workspaceRefs);
        expect(state.getState().projectAccountRows?.relationships).toBe(ready.projectAccountRows?.relationships);
    });
    it('keeps records outside a partial page until a complete census authoritatively removes them', () => {
        const state = store();
        state.getState().activateProjectAccountRowsScope(scope);
        state.getState().applyProjectAccountRowsForScope(scope, snapshot());
        const partial = { ...snapshot(), coverage: 'partial' as const, workspaceRefs: [snapshot().workspaceRefs[0]!] };
        state.getState().applyProjectAccountRowsForScope(scope, partial);
        expect(state.getState().projectAccountRows?.workspaceRefs).toHaveLength(2);
        expect(state.getState().projectAccountRows?.coverage).toBe('partial');
        state.getState().applyProjectAccountRowsForScope(scope, { ...partial, coverage: 'complete' });
        expect(state.getState().projectAccountRows?.workspaceRefs).toHaveLength(1);
    });
    it('does not disclose a prior Account projection before the new scope has activated', () => {
        const state = store();
        state.getState().activateProjectAccountRowsScope(scope);
        state.getState().applyProjectAccountRowsForScope(scope, snapshot());
        expect(readProjectWorkspaceRefs({ ...state.getState(), profileScope: { ...scope, accountId: 'other-account' } })).toEqual([]);
        expect(readProjectWorkspaceRefs({ ...state.getState(), profileScope: scope })).toHaveLength(2);
    });
    it('preserves newer row revisions across delayed full refreshes and keeps tombstones from resurrecting refs', () => {
        const state = store();
        state.getState().activateProjectAccountRowsScope(scope);
        const key = buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: scope.serverId, id: 'ref-a' });
        const latest = { ...snapshot(), workspaceRefs: [{ ...snapshot().workspaceRefs[0]!, label: 'Current' }], revisionsByPhysicalKey: { [key]: 3 } };
        state.getState().applyProjectAccountRowsForScope(scope, latest);
        const before = state.getState();
        state.getState().applyProjectAccountRowsForScope(scope, { ...latest, workspaceRefs: [{ ...latest.workspaceRefs[0]!, label: 'Old' }], revisionsByPhysicalKey: { [key]: 2 } });
        expect(state.getState()).toBe(before);
        state.getState().applyProjectAccountRowsForScope(scope, { ...latest, workspaceRefs: [], revisionsByPhysicalKey: { [key]: 4 } });
        expect(state.getState().projectAccountRows?.workspaceRefs).toEqual([]);
        const deleted = state.getState();
        state.getState().applyProjectAccountRowsForScope(scope, latest);
        expect(state.getState()).toBe(deleted);
    });
    it('compares graph and organization row revisions independently from checkout rows', () => {
        const state = store();
        state.getState().activateProjectAccountRowsScope(scope);
        const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'link-a', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'ref-a', betaWorkspaceRefId: 'ref-b', mode: 'keep_synced', enabled: true,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
        const graphKey = buildProjectAccountRowPhysicalKeyV1({ kind: 'relationship-graph' });
        const latest = { ...snapshot(), relationships: [relationship], organizations: [{ ...snapshot().organizations[0]!, revision: 2 }],
            revisionsByPhysicalKey: { [graphKey]: 6 } };
        state.getState().applyProjectAccountRowsForScope(scope, latest);
        const refs = state.getState().projectAccountRows?.workspaceRefs;
        state.getState().applyProjectAccountRowsForScope(scope, { ...latest, coverage: 'partial', workspaceRefs: [], organizations: [], relationships: [],
            revisionsByPhysicalKey: { [graphKey]: 7 } });
        expect(state.getState().projectAccountRows?.workspaceRefs).toBe(refs);
        expect(state.getState().projectAccountRows?.relationships).toEqual([]);
        expect(state.getState().pinnedWorkspaceRefIds).toEqual(['ref-a', 'ref-b']);
        state.getState().applyProjectAccountRowsForScope(scope, { ...latest, coverage: 'partial',
            organizations: [{ ...snapshot().organizations[0]!, revision: 1, value: { pinned: false } }] });
        expect(state.getState().projectAccountRows?.relationships).toEqual([]);
        expect(state.getState().pinnedWorkspaceRefIds).toEqual(['ref-a', 'ref-b']);
    });
});
