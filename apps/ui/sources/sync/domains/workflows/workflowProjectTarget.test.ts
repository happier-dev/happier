import { describe, expect, it } from 'vitest';
import { WorkflowProjectTargetV1Schema } from '@happier-dev/protocol/workflows';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import {
    resolveWorkflowProjectWorkspaceRefId,
    selectWorkflowProjectMachine,
    setWorkflowProjectDirectory,
    setWorkflowProjectFiles,
    setWorkflowProjectSessionPlacement,
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
    it('keeps in-place selection exact and drops it when selecting another folder', () => {
        const workspace = {
            v: 2, kind: 'managed', serverId: 'server-1', workspaceId: 'ws-managed', managedId: 'managed-1',
            rootPath: '/guest/repo', controller: { machineId: 'machine-1', installationId: 'installation' },
        } as const;
        const placement = { kind: 'in_place', workspace } as const;
        const current = { machineId: 'machine-1', workspaceRefId: workspace.workspaceId, directory: workspace.rootPath };
        expect(setWorkflowProjectSessionPlacement(current, placement, workspace.serverId)).toEqual({
            ...current, sessionPlacement: placement,
        });
        expect(setWorkflowProjectDirectory({
            ...context, current: { ...current, sessionPlacement: placement }, directory: '/home/dev/other',
        })).toEqual({ machineId: 'machine-1', directory: '/home/dev/other', workspaceRefId: 'ws-other' });
    });
    it('retains saved Session placement when editing the project folder', () => {
        const sessionPlacement = { kind: 'preset' as const, homeId: 'server-1', presetId: 'preset-1' };
        expect(setWorkflowProjectDirectory({ ...context,
            current: { machineId: 'machine-1', directory: '/home/dev/repo', sessionPlacement },
            directory: '/home/dev/other',
        })).toMatchObject({ directory: '/home/dev/other', workspaceRefId: 'ws-other', sessionPlacement });
    });

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

describe('a workflow placed on a cloud preset (J6)', () => {
    const current = { machineId: 'machine-1', directory: '/repo', workspaceRefId: 'ws-1' };
    const preset = { kind: 'preset' as const, homeId: 'home-1', presetId: 'boat-node-22' };

    it('saves the chosen preset with the workflow and keeps its folder', () => {
        expect(setWorkflowProjectSessionPlacement(current, preset)).toEqual({ ...current, sessionPlacement: preset });
    });
    it('retains the source Machine before workflow preset routing changes the Run host', () => {
        expect(setWorkflowProjectSessionPlacement(current, preset, 'source-home')).toMatchObject({
            sessionPlacement: { ...preset, projectFilesSource: {
                target: { serverId: 'source-home', machineId: current.machineId }, directory: current.directory,
            } },
        });
    });

    it.each([
        preset,
        { kind: 'machine', target: { serverId: 'source-home', machineId: current.machineId }, configuredSandbox: {
            kind: 'sandbox', configuredSandboxId: 'kept-config', presetId: 'kept-preset', lifecycle: 'shared-kept',
            provisioner: { pluginId: 'example.sandboxes', localId: 'sandbox' },
        } },
    ] as const)('saves and clears a Project files override for $kind placement', placement => {
        const selected = setWorkflowProjectSessionPlacement(current, placement, 'source-home');
        const projectFiles = { kind: 'sync', mode: 'keep_both_in_sync' } as const;
        const edited = WorkflowProjectTargetV1Schema.parse(setWorkflowProjectFiles(selected, projectFiles));
        expect(edited).toEqual({ ...current, sessionPlacement: { ...placement, projectFiles, projectFilesSource: {
            target: { serverId: 'source-home', machineId: current.machineId }, directory: current.directory,
        } } });
        const moved = setWorkflowProjectDirectory({ ...context, current: edited, directory: '/different' });
        expect(WorkflowProjectTargetV1Schema.parse(setWorkflowProjectFiles(moved, undefined))).toEqual({
            machineId: current.machineId, directory: '/different', sessionPlacement: { ...placement, projectFilesSource: {
                target: { serverId: 'source-home', machineId: current.machineId }, directory: '/different',
            } },
        });
    });

    it('goes back to the Machine when one is chosen again, even the same one', () => {
        const placed = setWorkflowProjectSessionPlacement(current, preset);
        expect(setWorkflowProjectSessionPlacement(placed, undefined)).toEqual(current);
        expect(selectWorkflowProjectMachine({ current: placed, machineId: 'machine-1', defaultDirectory: '/x', serverId: 'server-1', workspaceRefs: [] }))
            .toEqual(current);
    });
});
