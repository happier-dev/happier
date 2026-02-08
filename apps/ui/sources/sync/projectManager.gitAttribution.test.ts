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

describe('projectManager git attribution', () => {
    it('tracks and prunes session touched paths by project', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo') as any);

        projectManager.markSessionProjectGitTouchedPaths('s1', ['a.ts', 'b.ts'], 100);
        expect(projectManager.getSessionProjectGitTouchedPaths('s1').sort()).toEqual(['a.ts', 'b.ts']);

        projectManager.pruneSessionProjectGitTouchedPaths('s1', new Set(['a.ts']));
        expect(projectManager.getSessionProjectGitTouchedPaths('s1')).toEqual(['a.ts']);
    });

    it('stores bounded git operation log per project', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo') as any);

        projectManager.appendSessionProjectGitOperation('s1', {
            operation: 'commit',
            status: 'success',
            detail: 'abc123',
            timestamp: 10,
        });

        const log = projectManager.getSessionProjectGitOperationLog('s1');
        expect(log).toHaveLength(1);
        expect(log[0]?.operation).toBe('commit');
        expect(log[0]?.status).toBe('success');
        expect(log[0]?.detail).toBe('abc123');
    });
});
