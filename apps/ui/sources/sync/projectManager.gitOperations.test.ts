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

describe('projectManager git operation in-flight state', () => {
    it('locks operations per project and exposes lock state to sibling sessions', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo') as any);
        projectManager.addSession(createSession('s2', 'm1', '/repo') as any);

        const started = projectManager.beginSessionProjectGitOperation('s1', 'commit', 100);
        expect(started.started).toBe(true);
        if (!started.started) return;

        const visibleFromSibling = projectManager.getSessionProjectGitInFlightOperation('s2');
        expect(visibleFromSibling?.id).toBe(started.operation.id);
        expect(visibleFromSibling?.operation).toBe('commit');
        expect(visibleFromSibling?.sessionId).toBe('s1');

        const blocked = projectManager.beginSessionProjectGitOperation('s2', 'push', 101);
        expect(blocked.started).toBe(false);
        if (!blocked.started) {
            expect(blocked.reason).toBe('operation_in_flight');
            expect(blocked.inFlight?.id).toBe(started.operation.id);
        }

        expect(projectManager.finishSessionProjectGitOperation('s2', started.operation.id)).toBe(true);
        expect(projectManager.getSessionProjectGitInFlightOperation('s1')).toBeNull();
        expect(projectManager.getSessionProjectGitInFlightOperation('s2')).toBeNull();
    });

    it('returns missing_project when starting an operation for unknown session', () => {
        projectManager.clear();
        const result = projectManager.beginSessionProjectGitOperation('missing', 'commit', 1);
        expect(result.started).toBe(false);
        if (!result.started) {
            expect(result.reason).toBe('missing_project');
        }
    });

    it('clears in-flight operation when owning session is removed from the project', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo') as any);
        projectManager.addSession(createSession('s2', 'm1', '/repo') as any);

        const started = projectManager.beginSessionProjectGitOperation('s1', 'pull', 200);
        expect(started.started).toBe(true);

        projectManager.removeSession('s1');
        expect(projectManager.getSessionProjectGitInFlightOperation('s2')).toBeNull();
    });

    it('clears in-flight operation when the owning session moves to another project', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo-a') as any);
        projectManager.addSession(createSession('s2', 'm1', '/repo-a') as any);

        const started = projectManager.beginSessionProjectGitOperation('s1', 'push', 300);
        expect(started.started).toBe(true);

        projectManager.addSession(createSession('s1', 'm1', '/repo-b') as any);
        expect(projectManager.getSessionProjectGitInFlightOperation('s2')).toBeNull();
    });
});
