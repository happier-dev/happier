import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS scm surface', () => {
    it('defines only scm source-control method constants', () => {
        expect(RPC_METHODS.SCM_BACKEND_DESCRIBE).toBe('scm.backend.describe');
        expect(RPC_METHODS.SCM_STATUS_SNAPSHOT).toBe('scm.status.snapshot');
        expect(RPC_METHODS.SCM_DIFF_FILE).toBe('scm.diff.file');
        expect(RPC_METHODS.SCM_DIFF_COMMIT).toBe('scm.diff.commit');
        expect(RPC_METHODS.SCM_CHANGE_INCLUDE).toBe('scm.change.include');
        expect(RPC_METHODS.SCM_CHANGE_EXCLUDE).toBe('scm.change.exclude');
        expect(RPC_METHODS.SCM_CHANGE_DISCARD).toBe('scm.change.discard');
        expect(RPC_METHODS.SCM_COMMIT_CREATE).toBe('scm.commit.create');
        expect(RPC_METHODS.SCM_COMMIT_BACKOUT).toBe('scm.commit.backout');
        expect(RPC_METHODS.SCM_LOG_LIST).toBe('scm.log.list');
        expect(RPC_METHODS.SCM_BRANCH_LIST).toBe('scm.branch.list');
        expect(RPC_METHODS.SCM_BRANCH_CREATE).toBe('scm.branch.create');
        expect(RPC_METHODS.SCM_BRANCH_CHECKOUT).toBe('scm.branch.checkout');
        expect(RPC_METHODS.SCM_BRANCH_MERGE).toBe('scm.branch.merge');
        expect(RPC_METHODS.SCM_BRANCH_REBASE).toBe('scm.branch.rebase');
        expect(RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE).toBe('scm.branch.operation.continue');
        expect(RPC_METHODS.SCM_BRANCH_OPERATION_ABORT).toBe('scm.branch.operation.abort');
        expect(RPC_METHODS.SCM_REMOTE_ADD).toBe('scm.remote.add');
        expect(RPC_METHODS.SCM_REMOTE_SET_URL).toBe('scm.remote.setUrl');
        expect(RPC_METHODS.SCM_REMOTE_REMOVE).toBe('scm.remote.remove');
        expect(RPC_METHODS.SCM_REMOTE_FETCH).toBe('scm.remote.fetch');
        expect(RPC_METHODS.SCM_REMOTE_PULL).toBe('scm.remote.pull');
        expect(RPC_METHODS.SCM_REMOTE_PUSH).toBe('scm.remote.push');
        expect(RPC_METHODS.SCM_REMOTE_PUBLISH).toBe('scm.remote.publish');
        expect(RPC_METHODS.SCM_REPOSITORY_INIT).toBe('scm.repository.init');
        expect(RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK).toBe('scm.repository.removeIndexLock');
        expect(RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS).toBe(
            'scm.hostingRepository.describePublishTargets'
        );
        expect(RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH).toBe('scm.hostingRepository.publish');
        expect(RPC_METHODS.SCM_STASH_LIST).toBe('scm.stash.list');
        expect(RPC_METHODS.SCM_STASH_DROP).toBe('scm.stash.drop');
        expect(RPC_METHODS.SCM_STASH_POP).toBe('scm.stash.pop');
        expect(RPC_METHODS.SCM_STASH_APPLY).toBe('scm.stash.apply');
        expect(RPC_METHODS.SCM_STASH_SHOW).toBe('scm.stash.show');
        expect(RPC_METHODS.SCM_PULL_REQUEST_LIST).toBe('scm.pullRequest.list');
        expect(RPC_METHODS.SCM_PULL_REQUEST_GET).toBe('scm.pullRequest.get');
        expect(RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE).toBe('scm.pullRequest.openOrReuse');
        expect(RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE).toBe('scm.pullRequest.openCompose');
        expect(RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT).toBe('scm.pullRequest.checkout');
        expect(RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE).toBe('scm.pullRequest.prepareWorktree');
        expect(RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED).toBe('scm.pullRequest.runStacked');
    });

    it('does not expose git method constants', () => {
        expect(Object.keys(RPC_METHODS).some((key) => key.startsWith('GIT_'))).toBe(false);
    });
});
