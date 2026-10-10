import { describe, expect, it } from 'vitest';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import {
    resolveWorkflowProjectWorkspaceRefId,
    selectWorkflowProjectMachine,
    setWorkflowProjectDirectory,
} from './workflowProjectTarget';

function ref(input: Readonly<{ id: string; machineId?: string; rootPath: string; serverId?: string }>): WorkspaceRefV1 {
    return {
        id: input.id,
        serverId: input.serverId ?? 'server-1',
        machineId: input.machineId ?? 'machine-1',
        rootPath: input.rootPath,
        label: null,
        createdAtMs: 0,
        lastOpenedAtMs: null,
    };
}

const context = {
    serverId: 'server-1',
    workspaceRefs: [
        ref({ id: 'ws-repo', rootPath: '/home/dev/repo' }),
        ref({ id: 'ws-other', rootPath: '/home/dev/other' }),
        ref({ id: 'ws-elsewhere', machineId: 'machine-2', rootPath: '/home/dev/repo' }),
    ],
} as const;

describe('workflow project target', () => {
    it('does not pick a checkout when the selected Home and root have duplicate refs', () => {
        expect(resolveWorkflowProjectWorkspaceRefId({
            ...context,
            workspaceRefs: [ref({ id: 'first', rootPath: '/repo' }), ref({ id: 'second', rootPath: '/repo/' })],
            machineId: 'machine-1', directory: '/repo',
        })).toBeUndefined();
    });

    it('requires a containing Home before binding a folder', () => {
        expect(resolveWorkflowProjectWorkspaceRefId({
            ...context, serverId: null, machineId: 'machine-1', directory: '/home/dev/repo',
        })).toBeUndefined();
    });
    it('keeps a managed Session intent when changing Machine and binds a project only after choosing a folder', () => {
        const current = { machineId: 'machine-1', directory: { kind: 'managed' as const } };
        const next = selectWorkflowProjectMachine({ ...context, current, machineId: 'machine-2', defaultDirectory: '/home/dev/repo' });
        expect(next).toEqual({ machineId: 'machine-2', directory: { kind: 'managed' } });
        expect(setWorkflowProjectDirectory({ ...context, current: next, directory: '/home/dev/repo' }))
            .toEqual({ machineId: 'machine-2', directory: '/home/dev/repo', workspaceRefId: 'ws-elsewhere' });
    });
    it('drops a binding the edited directory no longer names', () => {
        const next = setWorkflowProjectDirectory({
            ...context,
            current: { machineId: 'machine-1', directory: '/home/dev/repo', workspaceRefId: 'ws-repo' },
            directory: '/home/dev/unregistered',
        });
        expect(next).toEqual({ machineId: 'machine-1', directory: '/home/dev/unregistered' });
        expect(next).not.toHaveProperty('workspaceRefId');
    });

    it('rebinds to the WorkspaceRef that owns the new directory', () => {
        expect(setWorkflowProjectDirectory({
            ...context,
            current: { machineId: 'machine-1', directory: '/home/dev/repo', workspaceRefId: 'ws-repo' },
            directory: '/home/dev/other',
        })).toEqual({ machineId: 'machine-1', directory: '/home/dev/other', workspaceRefId: 'ws-other' });
    });

    it('keeps the binding when the edit proves the same project path', () => {
        expect(setWorkflowProjectDirectory({
            ...context,
            // Only an unresolvable ref list would otherwise be read as "gone".
            workspaceRefs: [],
            current: { machineId: 'machine-1', directory: '/home/dev/repo', workspaceRefId: 'ws-repo' },
            directory: '/home/dev/repo/',
        })).toEqual({ machineId: 'machine-1', directory: '/home/dev/repo/', workspaceRefId: 'ws-repo' });
    });

    it('never binds another Machine’s workspace to this project', () => {
        expect(resolveWorkflowProjectWorkspaceRefId({
            ...context,
            machineId: 'machine-3',
            directory: '/home/dev/repo',
        })).toBeUndefined();
        expect(resolveWorkflowProjectWorkspaceRefId({
            ...context,
            machineId: 'machine-2',
            directory: '/home/dev/repo',
        })).toBe('ws-elsewhere');
    });

    it('changing Machine replaces the directory and its binding, and re-selecting the same Machine changes nothing', () => {
        const current = { machineId: 'machine-1', directory: '/home/dev/repo', workspaceRefId: 'ws-repo' } as const;
        expect(selectWorkflowProjectMachine({
            ...context,
            current,
            machineId: 'machine-2',
            defaultDirectory: '/home/dev/repo',
        })).toEqual({ machineId: 'machine-2', directory: '/home/dev/repo', workspaceRefId: 'ws-elsewhere' });
        expect(selectWorkflowProjectMachine({
            ...context,
            current,
            machineId: 'machine-1',
            defaultDirectory: '/somewhere/else',
        })).toBe(current);
    });
});
