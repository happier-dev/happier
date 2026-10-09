import { describe, expect, it } from 'vitest';

import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { materializeWorkspaceRefForMachineRoot, resolveWorkspaceRefById, resolveWorkspaceRefForMachineRoot } from './workspaceRefsV1';

describe('workspace ref resolution', () => {
    it('selects the explicitly qualified Home rather than dropping both same-root candidates', () => {
        const refs = ['one', 'two'].map(serverId => ({ id: 'same-id', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }));
        expect(resolveWorkspaceRefById(refs, 'same-id', 'two')).toEqual(refs[1]);
        expect(resolveWorkspaceRefForMachineRoot(refs, { serverId: 'two', machineId: 'machine', rootPath: '/repo' })).toEqual(refs[1]);
    });
    it('resolves one canonical workspace identity from machine and normalized root', () => {
        const refs: WorkspaceRefV1[] = [
            { id: 'workspace_a', serverId: 'server_a', machineId: 'machine_a', rootPath: 'C:\\Repo\\', createdAtMs: 1 },
            { id: 'workspace_b', serverId: 'server_b', machineId: 'machine_b', rootPath: '/repo', createdAtMs: 1 },
        ];
        expect(resolveWorkspaceRefForMachineRoot(refs, { serverId: 'server_a', machineId: 'machine_a', rootPath: 'c:/repo' }))
            .toEqual(refs[0]);
        expect(resolveWorkspaceRefForMachineRoot([
            ...refs,
            { ...refs[0]!, id: 'ambiguous', serverId: 'server_other' },
        ], { machineId: 'machine_a', rootPath: 'c:/repo' })).toBeNull();
    });

    it('resolves an id only when exactly one current workspace ref owns it', () => {
        const refs: WorkspaceRefV1[] = [
            { id: 'workspace_a', serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo-a', createdAtMs: 1 },
            { id: 'workspace_b', serverId: 'server_b', machineId: 'machine_b', rootPath: '/repo-b', createdAtMs: 1 },
        ];

        expect(resolveWorkspaceRefById(refs, ' workspace_a ')).toEqual(refs[0]);
        expect(resolveWorkspaceRefById(refs, 'workspace_missing')).toBeNull();
        expect(resolveWorkspaceRefById([...refs, { ...refs[0]!, serverId: 'server_other' }], 'workspace_a')).toBeNull();
    });

    it('materializes one stable ref for a canonical machine/root scope', () => {
        const existing: WorkspaceRefV1 = {
            id: 'workspace_a', serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo', createdAtMs: 1,
        };
        expect(materializeWorkspaceRefForMachineRoot([existing], {
            serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo/', nowMs: 2, createId: () => 'unused',
        })).toEqual({ workspaceRefs: [{ ...existing, projectKey: existing.id }], workspaceRef: { ...existing, projectKey: existing.id }, created: false });

        expect(materializeWorkspaceRefForMachineRoot([], {
            serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo', nowMs: 2, createId: () => 'workspace_new',
        })).toEqual({
            workspaceRefs: [{ id: 'workspace_new', projectKey: 'workspace_new', serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo', createdAtMs: 2 }],
            workspaceRef: { id: 'workspace_new', projectKey: 'workspace_new', serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo', createdAtMs: 2 },
            created: true,
        });
    });

    it('does not reuse a machine/root identity from another Account Home', () => {
        const existing: WorkspaceRefV1 = {
            id: 'workspace_a', serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo', createdAtMs: 1,
        };

        expect(materializeWorkspaceRefForMachineRoot([existing], {
            serverId: 'server_b', machineId: 'machine_a', rootPath: '/repo', nowMs: 2, createId: () => 'workspace_b',
        })).toEqual({
            workspaceRefs: [
                existing,
                { id: 'workspace_b', projectKey: 'workspace_b', serverId: 'server_b', machineId: 'machine_a', rootPath: '/repo', createdAtMs: 2 },
            ],
            workspaceRef: { id: 'workspace_b', projectKey: 'workspace_b', serverId: 'server_b', machineId: 'machine_a', rootPath: '/repo', createdAtMs: 2 },
            created: true,
        });
    });

    it('anchors enrichment and Source save without merging independent accepted Projects', () => {
        const repositoryIdentity = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/repo' };
        const refs = ['first', 'second'].map(id => ({ id, serverId: 'home', machineId: 'machine', rootPath: `/${id}`, createdAtMs: 1 }));
        const accepted = materializeWorkspaceRefForMachineRoot(refs, {
            serverId: 'home', machineId: 'machine', rootPath: '/first', nowMs: 2, createId: () => 'unused',
            repositoryIdentity, source: { sourceId: 'source', revision: 1 },
        });
        expect(accepted.workspaceRef).toMatchObject({ id: 'first', projectKey: 'first', repositoryIdentity, source: { sourceId: 'source', revision: 1 } });
        const enrichedSecond = materializeWorkspaceRefForMachineRoot(accepted.workspaceRefs, {
            serverId: 'home', machineId: 'machine', rootPath: '/second', nowMs: 3, createId: () => 'unused', repositoryIdentity,
        });
        expect(enrichedSecond.workspaceRef.projectKey).toBe('second');
        const additional = materializeWorkspaceRefForMachineRoot(accepted.workspaceRefs, {
            serverId: 'home', machineId: 'another', rootPath: '/clone', nowMs: 3, createId: () => 'new', source: { sourceId: 'source', revision: 1 },
        });
        expect(additional.workspaceRef.projectKey).toBe('first');
    });

    it('accepts an admitted child under the exact current parent anchor without merging an existing Project', () => {
        const parent = { id: 'parent', serverId: 'home', machineId: 'controller', rootPath: '/host', projectKey: 'project', createdAtMs: 1 };
        const input = { serverId: 'home', machineId: 'child', rootPath: '/child', parentWorkspace: {
            serverId: 'home', workspaceId: parent.id, machineId: parent.machineId, rootPath: parent.rootPath },
            nowMs: 2, createId: () => 'child-workspace' };
        expect(materializeWorkspaceRefForMachineRoot([parent], input).workspaceRef).toMatchObject({
            id: 'child-workspace', machineId: 'child', rootPath: '/child', projectKey: 'project' });
        const existing = { id: 'existing', serverId: 'home', machineId: 'child', rootPath: '/child', projectKey: 'other-project', createdAtMs: 1 };
        expect(materializeWorkspaceRefForMachineRoot([parent, existing], input).workspaceRef.projectKey).toBe('other-project');
        for (const current of [[], [{ ...parent, serverId: 'other-home' }], [{ ...parent, rootPath: '/replacement-host' }],
            [parent, { ...parent, machineId: 'another-controller' }]]) {
            expect(() => materializeWorkspaceRefForMachineRoot(current, input))
                .toThrow(expect.objectContaining({ code: 'workspace_ref_not_ready' }));
        }
    });
});
