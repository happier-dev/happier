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
        expect(RPC_METHODS.SCM_REMOTE_FETCH).toBe('scm.remote.fetch');
        expect(RPC_METHODS.SCM_REMOTE_PULL).toBe('scm.remote.pull');
        expect(RPC_METHODS.SCM_REMOTE_PUSH).toBe('scm.remote.push');
        expect(RPC_METHODS.SCM_REMOTE_PUBLISH).toBe('scm.remote.publish');
        expect(RPC_METHODS.SCM_STASH_LIST).toBe('scm.stash.list');
        expect(RPC_METHODS.SCM_STASH_DROP).toBe('scm.stash.drop');
        expect(RPC_METHODS.SCM_STASH_POP).toBe('scm.stash.pop');
        expect(RPC_METHODS.SCM_STASH_APPLY).toBe('scm.stash.apply');
        expect(RPC_METHODS.SCM_STASH_SHOW).toBe('scm.stash.show');
    });

    it('does not expose git method constants', () => {
        expect(Object.keys(RPC_METHODS).some((key) => key.startsWith('GIT_'))).toBe(false);
    });
});
