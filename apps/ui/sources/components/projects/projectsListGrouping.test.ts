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
    it('keeps pins first, ranks Project anchors by joined recency, and breaks ties deterministically', () => {
        const refs: WorkspaceRefV1[] = [
            { ...makeWorkspaceRef({ id: 'older', lastOpenedAtMs: 10 }), projectKey: 'a-older' },
            { ...makeWorkspaceRef({ id: 'recent-m2', machineId: 'm2', lastOpenedAtMs: 40 }), projectKey: 'recent' },
            { ...makeWorkspaceRef({ id: 'recent-m1', machineId: 'm1', lastOpenedAtMs: 40 }), projectKey: 'recent' },
            { ...makeWorkspaceRef({ id: 'tie-c', lastOpenedAtMs: 20 }), projectKey: 'c-tie' },
            { ...makeWorkspaceRef({ id: 'tie-b', lastOpenedAtMs: 20 }), projectKey: 'b-tie' },
            { ...makeWorkspaceRef({ id: 'pinned', lastOpenedAtMs: 1 }), projectKey: 'z-pinned' },
            { ...makeWorkspaceRef({ id: 'foreign', serverId: 'server-b', lastOpenedAtMs: 1000 }), projectKey: 'a-older' },
        ];
        const project = (workspaceRefs: readonly WorkspaceRefV1[]) => buildProjectsListGroups({
            activeServerId: 'server-a', workspaceRefs, pinnedWorkspaceRefIds: [],
            projectOrganizations: [{ key: { kind: 'project-organization', serverId: 'server-a', projectKey: 'z-pinned' }, value: { pinned: true } }],
        }).projectGroups;
        expect(project(refs).map(group => group.projectKey.projectKey)).toEqual(['z-pinned', 'recent', 'b-tie', 'c-tie', 'a-older']);
        expect(project(refs)[1]?.items.map(ref => ref.id)).toEqual(['recent-m1', 'recent-m2']);
        expect(project([...refs].reverse())).toEqual(project(refs));
    });

    it('keeps Hide on the anchored Home Project through enrichment and reload, then Show restores exact leaves', () => {
        const refs: WorkspaceRefV1[] = [
            { ...makeWorkspaceRef({ id: 'first', machineId: 'm2', rootPath: '/repo-b' }), projectKey: 'anchor' },
            { ...makeWorkspaceRef({ id: 'second', machineId: 'm1', rootPath: '/repo-a' }), projectKey: 'anchor',
                repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'org/repo' } },
            { ...makeWorkspaceRef({ id: 'independent', rootPath: '/independent' }), projectKey: 'independent',
                repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'org/repo' } },
        ];
        const input = { activeServerId: 'server-a', workspaceRefs: refs, pinnedWorkspaceRefIds: [],
            projectOrganizations: [{ key: { kind: 'project-organization' as const, serverId: 'server-a', projectKey: 'anchor' }, value: { hidden: true } }] };
        const hidden = buildProjectsListGroups(JSON.parse(JSON.stringify(input)));
        expect(hidden.projectGroups.map((group) => group.projectKey.projectKey)).toEqual(['independent']);
        expect(hidden.hiddenProjectGroups[0]?.items.map((ref) => ref.id)).toEqual(['second', 'first']);
        const shown = buildProjectsListGroups({ ...input, projectOrganizations: [
            { key: { kind: 'project-organization' as const, serverId: 'server-a', projectKey: 'anchor' }, value: { hidden: false } },
        ] });
        expect(shown.projectGroups.find((group) => group.projectKey.projectKey === 'anchor')?.items)
            .toEqual([refs[1], refs[0]]);
        expect(shown.hiddenProjectGroups).toEqual([]);
    });

    it('never merges unknown identity refs or the same anchor from another Home', () => {
        const groups = buildProjectsListGroups({ activeServerId: 'server-a', pinnedWorkspaceRefIds: [],
            workspaceRefs: [makeWorkspaceRef({ id: 'a' }), makeWorkspaceRef({ id: 'b' }),
                { ...makeWorkspaceRef({ id: 'foreign', serverId: 'server-b' }), projectKey: 'a' }],
            projectOrganizations: [{ key: { kind: 'project-organization' as const, serverId: 'server-b', projectKey: 'a' }, value: { hidden: true } }],
        });
        expect(groups.projectGroups.map((group) => group.items.map((ref) => ref.id))).toEqual([['a'], ['b']]);
        expect(groups.hiddenProjectGroups).toEqual([]);
    });

    it('keeps ambiguous exact refs visible even when their shared id is pinned', () => {
        const first = makeWorkspaceRef({ id: 'duplicate', rootPath: '/repo-a' });
        const second = makeWorkspaceRef({ id: 'duplicate', rootPath: '/repo-b' });
        const groups = buildProjectsListGroups({
            activeServerId: 'server-a', workspaceRefs: [first, second], pinnedWorkspaceRefIds: ['duplicate'],
        });
        expect(groups.pinned.map((ref) => ref.rootPath)).toEqual(['/repo-a', '/repo-b']);
        expect(groups.machineGroups).toEqual([]);
    });

    it('orders equally recent leaves deterministically without changing their exact Home/root', () => {
        const refs = [
            makeWorkspaceRef({ id: 'z', rootPath: '/z' }),
            makeWorkspaceRef({ id: 'a', rootPath: '/a' }),
            makeWorkspaceRef({ id: 'foreign', rootPath: '/a', serverId: 'server-b' }),
        ];
        const project = (items: readonly WorkspaceRefV1[]) => buildProjectsListGroups({
            activeServerId: 'server-a', workspaceRefs: items, pinnedWorkspaceRefIds: [],
        }).machineGroups[0]?.items.map(({ id, serverId, rootPath }) => ({ id, serverId, rootPath }));
        expect(project(refs)).toEqual([
            { id: 'a', serverId: 'server-a', rootPath: '/a' },
            { id: 'z', serverId: 'server-a', rootPath: '/z' },
        ]);
        expect(project([...refs].reverse())).toEqual(project(refs));
    });

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
