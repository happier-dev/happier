import { describe, expect, it, vi } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/plugin-sdk/scm';
import type { SessionPullRequestUpdateV1 } from '@happier-dev/channels-protocol/v1';
import { sessionPullRequestBindingFixture } from './testkit/sessionPullRequestBindingFixture.js';
import { readConversationBindingUpdateRow } from './accountLocalBindingPolicy.js';
import { prepareSessionPullRequestWatchRound } from './sessionPullRequestWatchRound.js';
import { GITHUB_CHANNEL_PULL_REQUESTS } from '../../scm-github/src/githubChannelContribution.js';

function fixture() {
    const value = sessionPullRequestBindingFixture('binding-1', 'session-1', 12);
    const { binding } = readConversationBindingUpdateRow({ row: { rowId: value.id, revision: 1, value }, bindingId: value.id });
    const update: SessionPullRequestUpdateV1 = { v: 1, bindingId: binding.id, sessionId: 'session-1',
        pullRequest: { repository: 'acme/widgets', number: 12 }, head: { sha: 'provider-head', ref: 'feature',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'fork/widgets' } },
        events: [{ kind: 'comment', id: 'comment-1', revision: '1', occurredAt: 10,
            author: { principalId: 'writer', kind: 'person' }, body: 'Fix this' }] };
    const snapshot: ScmWorkingSnapshot = { projectKey: 'project-1', fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/accepted/repo', backendId: 'git', mode: '.git', worktrees: [],
            remotes: [{ name: 'origin', fetchUrl: 'git@github.com:acme/widgets.git' },
                { name: 'fork', fetchUrl: 'git@github.com:fork/widgets.git' }] },
        capabilities: createScmCapabilities(), branch: { head: 'feature', headOid: 'provider-head', upstream: 'fork/feature', ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } };
    const pullRequest = { provider: { id: 'github', kind: 'github', displayName: 'GitHub' }, number: 12, title: 'Widgets',
        url: 'https://github.com/acme/widgets/pull/12', baseBranch: 'main', headBranch: 'feature',
        headRepositoryNameWithOwner: 'fork/widgets' as string | undefined, headSha: 'provider-head', state: 'open' };
    const execute = vi.fn(async (id: string) => {
        if (id === 'session.status.get') return { session: { id: 'session-1' }, acceptedWorkspace: {
            checkout: { serverId: 'srv_example', workspaceId: 'workspace-1', machineId: 'machine-1', rootPath: '/accepted/repo' },
        } };
        if (id === 'scm.pullRequest.get') return { success: true, pullRequest };
        if (id === 'scm.status.snapshot') return { success: true, snapshot };
        if (id === 'scm.remote.pull') return { success: true };
        throw new Error(`Unexpected Action ${id}`);
    });
    return { binding, update, provider: GITHUB_CHANNEL_PULL_REQUESTS, snapshot, pullRequest, execute, context: { services: { actions: { execute } as unknown as PluginServices['actions'] }, signal: new AbortController().signal } };
}
describe('PR fixing-round preparation', () => {
    it('reads the PR at the selected provider deployment', async () => {
        const input = fixture();
        const pullRequests = { repositoryKind: 'github' as const, deployment: 'https://forge.example.test',
            urlTemplate: 'https://forge.example.test/{repository}/pull/{number}', repositoryConnectionKeyPrefix: 'forge:repository:',
            publicationInstructions: 'Use the admitted native reply Action.' };
        input.pullRequest.url = 'https://forge.example.test/acme/widgets/pull/12';
        input.snapshot.repo.remotes = [{ name: 'fork', fetchUrl: 'git@forge.example.test:fork/widgets.git' }];
        await expect(prepareSessionPullRequestWatchRound({ ...input, provider: pullRequests }, input.context)).resolves.toEqual({ kind: 'ready' });
        expect(input.execute).toHaveBeenCalledWith('scm.pullRequest.get', { sessionId: 'session-1', cwd: '/accepted/repo',
            prReference: { url: input.pullRequest.url } }, expect.any(Object));
    });

    it('prepares one admitted round without evaluating permission between SCM steps', async () => {
        const input = fixture();
        const evaluatePermission = vi.fn(() => { throw new Error('A bounded round must not reauthorize'); });
        const admitted = { ...input, assertCurrent: evaluatePermission };
        const result = await Promise.allSettled([prepareSessionPullRequestWatchRound(admitted, input.context)]);
        expect(result).toEqual([{ status: 'fulfilled', value: { kind: 'ready' } }]);
        expect(evaluatePermission).not.toHaveBeenCalled();
        expect(input.execute.mock.calls.filter(([id]) => id === 'scm.remote.pull')).toHaveLength(1);
    });

    it('matches native canonical repository casing but rejects another PR identity or origin', async () => {
        const input = fixture();
        input.pullRequest.url = 'https://github.com/Acme/Widgets/pull/12';
        await expect(prepareSessionPullRequestWatchRound(input, input.context)).resolves.toEqual({ kind: 'ready' });
        for (const url of ['https://github.com/other/widgets/pull/12', 'https://github.com/acme/widgets/pull/13',
            'https://example.test/acme/widgets/pull/12', 'https://github.com/acme/widgets/issues/12']) {
            input.execute.mockClear();
            input.pullRequest.url = url;
            await expect(prepareSessionPullRequestWatchRound(input, input.context)).resolves.toEqual({ kind: 'held', reason: 'scope' });
            expect(input.execute.mock.calls.some(([id]) => id === 'scm.remote.pull')).toBe(false);
        }
    });
    it('prepares the current admitted own-pushed head without rewriting the historical feedback head', async () => {
        const input = fixture();
        input.snapshot.branch.headOid = 'newer-own-head';
        input.pullRequest.headSha = 'newer-own-head';
        await expect(prepareSessionPullRequestWatchRound(input, input.context)).resolves.toEqual({ kind: 'ready' });
        expect(input.update.head.sha).toBe('provider-head');
        expect(input.execute).toHaveBeenCalledWith('scm.pullRequest.get', { sessionId: 'session-1', cwd: '/accepted/repo',
            prReference: { url: 'https://github.com/acme/widgets/pull/12' } }, expect.any(Object));
    });
    it('pulls only the measured fork head into the exact accepted Session workspace using the no-stash ff-only default', async () => {
        const input = fixture();
        await expect(prepareSessionPullRequestWatchRound(input, input.context)).resolves.toMatchObject({ kind: 'ready' });
        expect(input.execute).toHaveBeenCalledWith('scm.remote.pull', { sessionId: 'session-1', cwd: '/accepted/repo',
            remote: 'fork', branch: 'feature', dirtyPolicy: 'allow_git' }, expect.any(Object));
        input.snapshot.entries.push({ path: 'local.txt', previousPath: null, kind: 'modified', includeStatus: '', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } });
        // Git owns overlap refusal. Non-overlapping dirt is not a new blanket hold.
        await expect(prepareSessionPullRequestWatchRound(input, input.context)).resolves.toMatchObject({ kind: 'ready' });
    });
    it('holds a missing measured head repository or wrong branch without attempting a pull', async () => {
        const input = fixture();
        input.pullRequest.headRepositoryNameWithOwner = undefined;
        await expect(prepareSessionPullRequestWatchRound(input, input.context)).resolves.toEqual({ kind: 'held', reason: 'remote' });
        expect(input.execute.mock.calls.some(([id]) => id === 'scm.remote.pull')).toBe(false);
        input.pullRequest.headRepositoryNameWithOwner = 'fork/widgets';
        input.snapshot.branch.head = 'other-branch';
        await expect(prepareSessionPullRequestWatchRound(input, input.context)).resolves.toEqual({ kind: 'held', reason: 'branch' });
        expect(input.execute.mock.calls.some(([id]) => id === 'scm.remote.pull')).toBe(false);
    });
});
