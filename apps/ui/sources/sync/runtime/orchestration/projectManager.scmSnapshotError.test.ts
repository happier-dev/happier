import { describe, expect, it } from 'vitest';

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

describe('projectManager scm snapshot error state', () => {
    it('stores and clears snapshot errors per project and exposes them to sibling sessions', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo') as any);
        projectManager.addSession(createSession('s2', 'm1', '/repo') as any);

        projectManager.updateSessionProjectScmSnapshotError('s1', {
            message: 'Session bridge unavailable',
            at: 123,
        });

        expect(projectManager.getSessionProjectScmSnapshotError('s1')).toEqual({
            message: 'Session bridge unavailable',
            at: 123,
        });
        expect(projectManager.getSessionProjectScmSnapshotError('s2')).toEqual({
            message: 'Session bridge unavailable',
            at: 123,
        });

        projectManager.updateSessionProjectScmSnapshotError('s1', null);
        expect(projectManager.getSessionProjectScmSnapshotError('s1')).toBeNull();
        expect(projectManager.getSessionProjectScmSnapshotError('s2')).toBeNull();
    });

    it('supports sessions missing machineId by falling back to host for project grouping', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', '' as any, '/repo') as any);
        projectManager.addSession(createSession('s2', '' as any, '/repo') as any);

        projectManager.updateSessionProjectScmSnapshotError('s1', {
            message: 'Snapshot failed',
            at: 456,
        });

        expect(projectManager.getSessionProjectScmSnapshotError('s1')?.message).toBe('Snapshot failed');
        expect(projectManager.getSessionProjectScmSnapshotError('s2')?.message).toBe('Snapshot failed');
    });
});
