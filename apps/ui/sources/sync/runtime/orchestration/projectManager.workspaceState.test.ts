import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { projectManager } from './projectManager';
import { resolveProjectForSession } from './projectForSessionResolver';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

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

    it('does not register managed Sessions as Projects through direct or bulk admission', () => {
        const managed = createSessionFixture({ id: 'managed', metadata: {
            machineId: 'm1', host: 'h', path: '/private/chat-1', sessionDirectoryV1: { v: 1, kind: 'managed' },
        } });
        const second = createSessionFixture({ id: 'second', metadataLayoutVersion: 1, ownerMetadataView: {
            machineId: 'm1', host: 'h', path: '/private/chat-2', sessionDirectoryV1: { v: 1, kind: 'managed' },
        } });
        const folder = createSessionFixture({ id: 'folder', metadata: { machineId: 'm1', host: 'h', path: '/repo' } });

        projectManager.addSession(managed, { serverId: 's' });
        expect(projectManager.getProjectForSession(managed.id)).toBeNull();
        expect(resolveProjectForSession({ managed }, managed.id)).toBeNull();

        projectManager.updateSessions([managed, second, folder], undefined, 's');
        expect(projectManager.getProjectForWorkspace({ serverId: 's', machineId: 'm1', rootPath: '/repo' })?.sessionIds).toEqual([folder.id]);
        expect(projectManager.getProjectForSession(second.id)).toBeNull();
        expect(resolveProjectForSession({ second }, second.id)).toBeNull();
        expect(projectManager.getProjectForSession(folder.id)?.sessionIds).toEqual([folder.id]);
    });

    it('removes a stale Project mapping when owner metadata classifies the Session as managed', () => {
        const folder = createSessionFixture({ id: 'chat', metadata: { machineId: 'm1', host: 'h', path: '/private/chat' } });
        projectManager.addSession(folder, { serverId: 's' });
        expect(projectManager.getProjectForSession(folder.id)).not.toBeNull();
        const managed = createSessionFixture({ ...folder, metadata: {
            machineId: 'm1', host: 'h', path: '/private/chat', sessionDirectoryV1: { v: 1, kind: 'managed' },
        } });

        expect(resolveProjectForSession({ chat: managed }, managed.id)).toBeNull();
        projectManager.updateSessions([managed], undefined, 's');
        expect(projectManager.getProjectForSession(managed.id)).toBeNull();
        expect(projectManager.getProjectForWorkspace({ serverId: 's', machineId: 'm1', rootPath: '/private/chat' })).toBeNull();

        projectManager.addSession(folder, { serverId: 's' });
        expect(projectManager.getProjectForSession(folder.id)?.key.rootPath).toBe('/private/chat');
    });

    it('publishes only real snapshot changes through every writer and clears/removals, until demand ends', () => {
        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'runtime-only', fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'feature', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
                includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        };
        const branches: (string | null)[] = [];
        const stop = projectManager.subscribeScmSnapshots(() => {
            branches.push(projectManager.getWorkspaceScmSnapshot(scope)?.branch.head ?? null);
        }, new Set([buildWorkspaceCacheKey(scope)]));
        onTestFinished(stop);
        projectManager.updateWorkspaceScmSnapshot(scope, null);
        expect(branches).toEqual([]);
        projectManager.updateWorkspaceScmSnapshot(scope, snapshot);
        projectManager.updateWorkspaceScmSnapshot(scope, { ...snapshot, fetchedAt: 2 });
        expect(branches).toEqual(['feature']);
        projectManager.updateWorkspaceScmSnapshot({ ...scope, rootPath: '/unrelated' }, snapshot);
        expect(branches).toEqual(['feature']);
        projectManager.addSession(createSessionFixture({ id: 's1', metadata: { machineId: 'm1', path: '/repo', host: 'h' } }), { serverId: 's' });
        const projectId = projectManager.getProjectForWorkspace(scope)!.id;
        const onBranch = (head: string) => ({ ...snapshot, branch: { ...snapshot.branch, head } });
        projectManager.updateSessionProjectScmSnapshot('s1', onBranch('session'));
        projectManager.updateProjectScmSnapshot(scope, onBranch('key'));
        projectManager.updateProjectScmSnapshotById(projectId, onBranch('id'));
        projectManager.clearProjectScmStatus(projectId);
        projectManager.updateWorkspaceScmSnapshot(scope, snapshot);
        projectManager.removeSession('s1');
        projectManager.updateWorkspaceScmSnapshot(scope, snapshot);
        projectManager.clear();
        expect(branches).toEqual(['feature', 'session', 'key', 'id', null, 'feature', null, 'feature', null]);
        stop();
        projectManager.updateWorkspaceScmSnapshot(scope, snapshot);
        expect(branches).toHaveLength(9);
    });

    it('locks operations per workspace even when no session exists', () => {
        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        const started = projectManager.beginWorkspaceScmOperation(scope, 'commit', 100);
        expect(started.started).toBe(true);
        if (!started.started) return;

        expect(projectManager.getWorkspaceScmInFlightOperation(scope)?.operation).toBe('commit');
        expect(started.operation.sessionId).toBe('workspace');
        expect(projectManager.finishWorkspaceScmOperation(scope, started.operation.id)).toBe(true);
        expect(projectManager.getWorkspaceScmInFlightOperation(scope)).toBeNull();
        projectManager.appendWorkspaceScmOperation(scope, { operation: 'commit', status: 'success', timestamp: 101 });
        expect(projectManager.getWorkspaceScmOperationLog(scope)[0]?.sessionId).toBe('workspace');
    });

    it('does not duplicate SCM state between an explicit workspace and a session in the same folder', () => {
        const scope = { serverId: 's', machineId: 'm1', rootPath: '/repo' };
        projectManager.markWorkspaceScmCommitSelectionPaths(scope, ['a.ts'], 10);

        projectManager.addSession(createSession('s1', 'm1', '/repo') as any, { serverId: 's' });
        expect(projectManager.getSessionProjectScmCommitSelectionPaths('s1')).toEqual(['a.ts']);

        projectManager.markSessionProjectScmCommitSelectionPaths('s1', ['b.ts'], 11);
        expect(projectManager.getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['a.ts', 'b.ts']);
    });
});
