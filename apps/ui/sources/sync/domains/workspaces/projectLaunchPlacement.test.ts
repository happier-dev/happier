import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceRefV1 } from '@happier-dev/protocol';

import { collectProjectLaunchPlacementProjects } from './projectLaunchPlacement';

function ref(overrides: Partial<WorkspaceRefV1> = {}): WorkspaceRefV1 {
    return {
        id: 'workspace_1',
        serverId: 'server_1',
        machineId: 'machine_1',
        rootPath: '/home/dev/app',
        label: null,
        createdAtMs: 1,
        lastOpenedAtMs: null,
        ...overrides,
    };
}

describe('collectProjectLaunchPlacementProjects', () => {
    it('reads each project through its normalized workspace scope', () => {
        const readSnapshot = vi.fn().mockReturnValue(null);
        const projects = collectProjectLaunchPlacementProjects({
            workspaceRefs: [ref({ rootPath: '/home/dev//app/' })],
            readSnapshot,
            isMachineReachable: () => true,
        });

        expect(readSnapshot).toHaveBeenCalledWith({
            serverId: 'server_1',
            machineId: 'machine_1',
            rootPath: '/home/dev/app',
        });
        expect(projects).toEqual([
            { workspaceRef: expect.objectContaining({ id: 'workspace_1' }), snapshot: null, reachable: true },
        ]);
    });

    it('drops a ref whose scope does not normalize instead of querying a guessed key', () => {
        const readSnapshot = vi.fn().mockReturnValue(null);
        const projects = collectProjectLaunchPlacementProjects({
            workspaceRefs: [ref({ id: 'blank_machine', machineId: '   ' }), ref({ id: 'ok' })],
            readSnapshot,
            isMachineReachable: () => true,
        });

        expect(projects.map((project) => project.workspaceRef.id)).toEqual(['ok']);
        expect(readSnapshot).toHaveBeenCalledTimes(1);
    });

    it('carries the caller-owned reachability answer per machine', () => {
        const projects = collectProjectLaunchPlacementProjects({
            workspaceRefs: [ref({ id: 'a' }), ref({ id: 'b', machineId: 'machine_2' })],
            readSnapshot: () => null,
            isMachineReachable: (machineId) => machineId === 'machine_2',
        });

        expect(projects.map((project) => project.reachable)).toEqual([false, true]);
    });
});
