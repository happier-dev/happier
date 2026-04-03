import { beforeEach, describe, expect, it } from 'vitest';

import { projectManager } from './projectManager';

function createSession(id: string, machineId: string, path: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId,
            path,
            host: 'h',
            version: '1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
    };
}

describe('projectManager workspace-scoped SCM state', () => {
    beforeEach(() => {
        projectManager.clear();
    });

    it('tracks touched paths for an explicit workspace even when no session exists', () => {
        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        projectManager.markWorkspaceScmTouchedPaths(scope, ['a.ts', 'b.ts'], 10);
        expect(projectManager.getWorkspaceScmTouchedPaths(scope)).toEqual(['a.ts', 'b.ts']);
    });

    it('locks operations per workspace even when no session exists', () => {
        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        const started = projectManager.beginWorkspaceScmOperation(scope, 'commit', 100);
        expect(started.started).toBe(true);
        if (!started.started) return;

        expect(projectManager.getWorkspaceScmInFlightOperation(scope)?.operation).toBe('commit');
        expect(projectManager.finishWorkspaceScmOperation(scope, started.operation.id)).toBe(true);
        expect(projectManager.getWorkspaceScmInFlightOperation(scope)).toBeNull();
    });

    it('does not duplicate SCM state between an explicit workspace and a session in the same folder', () => {
        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        projectManager.markWorkspaceScmTouchedPaths(scope, ['a.ts'], 10);

        projectManager.addSession(createSession('s1', 'm1', '/repo') as any, { serverId: 's' });
        expect(projectManager.getSessionProjectScmTouchedPaths('s1')).toEqual(['a.ts']);

        projectManager.markSessionProjectScmTouchedPaths('s1', ['b.ts'], 11);
        expect(projectManager.getWorkspaceScmTouchedPaths(scope)).toEqual(['a.ts', 'b.ts']);
    });
});
