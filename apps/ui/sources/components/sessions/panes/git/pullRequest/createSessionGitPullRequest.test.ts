import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { selectScmWriteOperation } from '@/scm/operations/selectScmWriteOperation';

// The RPC adapter is the network boundary; the lock, the operation log and the projection stay real.
const openOrReuse = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/sessionScm', () => ({ sessionScmPullRequestOpenOrReuse: openOrReuse }));

import { createSessionGitPullRequest } from './createSessionGitPullRequest';

const provider = {
    id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
    urlSafety: { allowedSchemes: ['https:'] },
};

function session(id: string) {
    return {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: { machineId: 'm1', path: '/repo', host: 'h', version: '1' },
        metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        presence: 'online' as const,
    };
}

const state = {
    beginSessionProjectScmOperation: (sessionId: string, operation: Parameters<typeof projectManager.beginSessionProjectScmOperation>[1]) =>
        projectManager.beginSessionProjectScmOperation(sessionId, operation),
    finishSessionProjectScmOperation: (sessionId: string, operationId: string) => projectManager.finishSessionProjectScmOperation(sessionId, operationId),
    updateSessionProjectScmOperationProgress: (sessionId: string, operationId: string, progressText?: string) =>
        projectManager.updateSessionProjectScmOperationProgress(sessionId, operationId, progressText),
    appendSessionProjectScmOperation: (sessionId: string, entry: Parameters<typeof projectManager.appendSessionProjectScmOperation>[1]) =>
        projectManager.appendSessionProjectScmOperation(sessionId, entry),
};

const outcomeLine = () => selectScmWriteOperation({
    inFlight: projectManager.getSessionProjectScmInFlightOperation('s1'),
    log: projectManager.getSessionProjectScmOperationLog('s1'),
    machineReachable: true,
});

beforeEach(() => {
    openOrReuse.mockReset();
    projectManager.clear();
    projectManager.addSession(session('s1') as never);
});

describe('createSessionGitPullRequest', () => {
    it('creates the pull request from the form and records it where the pane\'s outcome line reads', async () => {
        openOrReuse.mockResolvedValue({
            success: true,
            reused: false,
            pullRequest: {
                provider, number: 2501, title: 'Key the settings modal by route',
                url: 'https://github.com/o/r/pull/2501', baseBranch: 'dev', headBranch: 'v0.3', state: 'open',
            },
            nextAction: { kind: 'none' },
        });

        const outcome = await createSessionGitPullRequest({
            state, sessionId: 's1', machineReachable: true, draftSupported: true,
            request: { base: 'dev', head: 'v0.3', title: 'Key the settings modal by route', body: 'Fixes the remount.', draft: true },
        });

        expect(outcome).toMatchObject({ kind: 'created', number: 2501, url: 'https://github.com/o/r/pull/2501',
            pullRequest: { title: 'Key the settings modal by route', headBranch: 'v0.3', baseBranch: 'dev', provider } });
        expect(openOrReuse).toHaveBeenCalledWith('s1', {
            base: 'dev', head: 'v0.3', title: 'Key the settings modal by route', body: 'Fixes the remount.', draft: true,
        }, undefined);
        expect(outcomeLine()).toMatchObject({ phase: 'succeeded', action: 'create_pr' });
    });

    it('never asks an older daemon for a draft it cannot create', async () => {
        openOrReuse.mockResolvedValue({ success: true, composeUrl: 'https://github.com/o/r/compare/dev...v0.3', nextAction: { kind: 'none' } });
        const outcome = await createSessionGitPullRequest({
            state, sessionId: 's1', machineReachable: true, draftSupported: false,
            request: { base: 'dev', head: 'v0.3', title: '', body: '', draft: true },
        });
        expect(openOrReuse.mock.calls[0]![1]).toEqual({ base: 'dev', head: 'v0.3', body: '' });
        expect(outcome).toMatchObject({ kind: 'provider-page', url: 'https://github.com/o/r/compare/dev...v0.3' });
        expect(outcomeLine()).toMatchObject({ phase: 'needs_input', action: 'create_pr' });
    });

    it('reports a classified failure and keeps it in the operation log', async () => {
        openOrReuse.mockResolvedValue({ success: false, error: 'gh auth login required', errorCode: 'REMOTE_AUTH_REQUIRED' });
        const outcome = await createSessionGitPullRequest({
            state, sessionId: 's1', machineReachable: true, draftSupported: true,
            request: { base: 'dev', head: 'v0.3', title: 'T', body: '', draft: false },
        });
        expect(outcome).toMatchObject({ kind: 'failed', errorCode: 'REMOTE_AUTH_REQUIRED' });
        expect(outcomeLine()).toMatchObject({ phase: 'needs_input', action: 'create_pr', outcome: { errorCode: 'REMOTE_AUTH_REQUIRED' } });
    });

    it('does not start while another Git operation holds the project', async () => {
        const held = projectManager.beginSessionProjectScmOperation('s1', 'push');
        expect(held.started).toBe(true);
        const outcome = await createSessionGitPullRequest({
            state, sessionId: 's1', machineReachable: true, draftSupported: true,
            request: { base: 'dev', head: 'v0.3', title: 'T', body: '', draft: false },
        });
        expect(outcome.kind).toBe('blocked');
        expect(openOrReuse).not.toHaveBeenCalled();
    });
});
