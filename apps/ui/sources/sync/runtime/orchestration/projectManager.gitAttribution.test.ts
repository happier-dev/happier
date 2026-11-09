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
    it('stores bounded git operation log per project', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo') as any);

        projectManager.appendSessionProjectScmOperation('s1', {
            operation: 'commit',
            status: 'success',
            detail: 'abc123',
            timestamp: 10,
        });

        const log = projectManager.getSessionProjectScmOperationLog('s1');
        expect(log).toHaveLength(1);
        expect(log[0]?.operation).toBe('commit');
        expect(log[0]?.status).toBe('success');
        expect(log[0]?.detail).toBe('abc123');
    });

    it('tracks and prunes commit selection paths at the project (workspace) scope', () => {
        projectManager.clear();
        projectManager.addSession(createSession('s1', 'm1', '/repo') as any);
        projectManager.addSession(createSession('s2', 'm1', '/repo') as any);

        projectManager.markSessionProjectScmCommitSelectionPaths('s1', ['a.ts', 'b.ts']);
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s1')).toEqual(['a.ts', 'b.ts']);
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s2')).toEqual(['a.ts', 'b.ts']);

        projectManager.unmarkSessionProjectScmCommitSelectionPaths('s2', ['b.ts']);
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s1')).toEqual(['a.ts']);
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s2')).toEqual(['a.ts']);

        projectManager.markSessionProjectScmCommitSelectionPaths('s1', ['stale.ts']);
        projectManager.pruneSessionProjectScmCommitSelectionPaths('s1', new Set(['a.ts']));
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s1')).toEqual(['a.ts']);
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s2')).toEqual(['a.ts']);

        projectManager.clearSessionProjectScmCommitSelectionPaths('s2');
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s1')).toEqual([]);
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s2')).toEqual([]);
    });

    it('stores and removes patch selection by literal filename identity', () => {
        projectManager.clear();
        projectManager.addSession(createSession('literal', 'm1', '/repo') as Parameters<typeof projectManager.addSession>[0]);
        for (const path of ['file', 'file ', ' ', '']) {
            projectManager.upsertSessionProjectScmCommitSelectionPatch('literal', { path, patch: 'non-empty patch' });
        }
        expect(new Set(projectManager.getSessionProjectScmCommitSelectionPatches('literal').map(({ path }) => path)))
            .toEqual(new Set(['file', 'file ', ' ']));
        projectManager.removeSessionProjectScmCommitSelectionPatch('literal', 'file ');
        expect(new Set(projectManager.getSessionProjectScmCommitSelectionPatches('literal').map(({ path }) => path)))
            .toEqual(new Set(['file', ' ']));
    });
});
