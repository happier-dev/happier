import { describe, expect, it } from 'vitest';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { buildProjectsListGroups } from './projectsListGrouping';

function makeWorkspaceRef(overrides: Partial<WorkspaceRefV1>): WorkspaceRefV1 {
    return {
        id: overrides.id ?? 'ref-1',
        serverId: overrides.serverId ?? 'server-a',
        machineId: overrides.machineId ?? 'machine-a',
        rootPath: overrides.rootPath ?? '/repo',
        label: overrides.label ?? null,
        createdAtMs: overrides.createdAtMs ?? 1,
        lastOpenedAtMs: overrides.lastOpenedAtMs ?? null,
    };
}

describe('buildProjectsListGroups', () => {
    it('orders pinned by pinned ids and groups remaining by machineId', () => {
        const refs: WorkspaceRefV1[] = [
            makeWorkspaceRef({ id: 'a', machineId: 'm1', rootPath: '/a', lastOpenedAtMs: 10 }),
            makeWorkspaceRef({ id: 'b', machineId: 'm2', rootPath: '/b', lastOpenedAtMs: 20 }),
            makeWorkspaceRef({ id: 'c', machineId: 'm1', rootPath: '/c', lastOpenedAtMs: 30 }),
            makeWorkspaceRef({ id: 'other-server', serverId: 'server-b', machineId: 'm1', rootPath: '/x' }),
        ];

        const result = buildProjectsListGroups({
            activeServerId: 'server-a',
            workspaceRefs: refs,
            pinnedWorkspaceRefIds: ['c', 'missing', 'b'],
        });

        expect(result.pinned.map((ref) => ref.id)).toEqual(['c', 'b']);
        expect(result.machineGroups.map((group) => group.machineId)).toEqual(['m1']);
        expect(result.machineGroups[0]?.items.map((ref) => ref.id)).toEqual(['a']);
    });

    it('sorts items within a machine group by lastOpenedAtMs desc then createdAtMs desc', () => {
        const refs: WorkspaceRefV1[] = [
            makeWorkspaceRef({ id: 'a', machineId: 'm1', lastOpenedAtMs: 10, createdAtMs: 1 }),
            makeWorkspaceRef({ id: 'b', machineId: 'm1', lastOpenedAtMs: 10, createdAtMs: 5 }),
            makeWorkspaceRef({ id: 'c', machineId: 'm1', lastOpenedAtMs: 20, createdAtMs: 2 }),
            makeWorkspaceRef({ id: 'd', machineId: 'm1', lastOpenedAtMs: null, createdAtMs: 99 }),
        ];

        const result = buildProjectsListGroups({
            activeServerId: 'server-a',
            workspaceRefs: refs,
            pinnedWorkspaceRefIds: [],
        });

        expect(result.machineGroups).toHaveLength(1);
        expect(result.machineGroups[0]?.items.map((ref) => ref.id)).toEqual(['c', 'b', 'a', 'd']);
    });
});
