import { describe, expect, it } from 'vitest';

import { GIT_SCM_BACKEND_CAPABILITIES } from '@happier-dev/plugins-scm-git';
import { SAPLING_SCM_BACKEND_CAPABILITIES } from '@happier-dev/plugins-scm-sapling';
import {
    getCapabilityLeaf,
    listCapabilityLeaves,
    type ScmBackendCapabilityLeafPath,
} from './scmBackendContractAssertions';
import {
    assertScmBackendContractLeafCoverage,
    scmCapabilityPathKey,
} from './scmBackendContractCoverage';
import { shouldRunScmBackendLeafAccount } from './scmBackendContractHarness';
import { createScmBackendCapabilityLeafAccounts } from './scmBackendContractLeafAccounts';

function pathKey(path: ScmBackendCapabilityLeafPath): string {
    return scmCapabilityPathKey(path);
}

describe('SCM backend contract capability coverage', () => {
    it('accounts for every supported Git grouped capability leaf', () => {
        const accountPaths = new Set(
            createScmBackendCapabilityLeafAccounts({ repoMode: '.git' }).map((account) => pathKey(account.path)),
        );
        const unaccountedSupportedLeaves = listCapabilityLeaves(GIT_SCM_BACKEND_CAPABILITIES).filter((path) => {
            const leaf = getCapabilityLeaf(GIT_SCM_BACKEND_CAPABILITIES, path);
            return leaf?.support === 'supported' && !accountPaths.has(pathKey(path));
        });

        expect(unaccountedSupportedLeaves.map(pathKey)).toEqual([]);
    });

    it('accounts for every Sapling unsupported leaf that has a backend operation', () => {
        const accounts = createScmBackendCapabilityLeafAccounts({ repoMode: '.sl' });
        const accountPaths = new Set(accounts.map((account) => pathKey(account.path)));
        const backendOperationLeaves = new Set([
            'read.branches',
            'read.stash',
            'changeSet.include',
            'changeSet.exclude',
            'commit.lineSelection',
            'remote.add',
            'remote.setUrl',
            'remote.remove',
            'remote.publish',
            'branch.list',
            'branch.create',
            'branch.checkout',
            'branch.merge',
            'branch.rebase',
            'branch.operationControl',
            'worktree.create',
            'worktree.remove',
            'worktree.prune',
            'lifecycle.init',
            'lifecycle.removeIndexLock',
            'hosting.pullRequestRead',
            'hosting.pullRequestCreate',
        ]);
        const unaccountedUnsupportedLeaves = listCapabilityLeaves(SAPLING_SCM_BACKEND_CAPABILITIES).filter((path) => {
            const key = pathKey(path);
            const leaf = getCapabilityLeaf(SAPLING_SCM_BACKEND_CAPABILITIES, path);
            return leaf?.support === 'unsupported' && backendOperationLeaves.has(key) && !accountPaths.has(key);
        });

        expect(unaccountedUnsupportedLeaves.map(pathKey)).toEqual([]);
    });

    it('marks Sapling unsupported backend-method leaves runnable without sl', () => {
        const accountsByPath = new Map(
            createScmBackendCapabilityLeafAccounts({ repoMode: '.sl' })
                .map((account) => [pathKey(account.path), account]),
        );

        for (const key of [
            'branch.list',
            'branch.create',
            'branch.checkout',
            'branch.merge',
            'branch.rebase',
            'branch.operationControl',
            'worktree.create',
            'worktree.remove',
            'worktree.prune',
            'hosting.pullRequestRead',
            'hosting.pullRequestCreate',
        ]) {
            const account = accountsByPath.get(key);
            expect(account?.kind, key).toBe('unsupported-method');
            expect(account?.requiresExecutable, key).toBe(false);
            expect(account?.assertUnsupported, key).toBeTypeOf('function');
        }
    });

    it('runs non-executable unsupported-method accounts when the executable is unavailable', () => {
        const accountsByPath = new Map(
            createScmBackendCapabilityLeafAccounts({ repoMode: '.sl' })
                .map((account) => [pathKey(account.path), account]),
        );

        const branchList = accountsByPath.get('branch.list');
        const readStatus = accountsByPath.get('read.status');

        expect(branchList).toBeDefined();
        expect(readStatus).toBeDefined();
        if (!branchList || !readStatus) return;

        expect(shouldRunScmBackendLeafAccount({
            account: branchList,
            executableAvailable: false,
        })).toBe(true);
        expect(shouldRunScmBackendLeafAccount({
            account: readStatus,
            executableAvailable: false,
        })).toBe(false);
    });

    it('fails when a supported grouped capability leaf has no coverage account', () => {
        const accounts = createScmBackendCapabilityLeafAccounts({ repoMode: '.git' })
            .filter((account) => pathKey(account.path) !== 'remote.fetch');

        expect(() => assertScmBackendContractLeafCoverage({
            backendId: 'git',
            capabilities: GIT_SCM_BACKEND_CAPABILITIES,
            accounts,
        })).toThrow(/remote\.fetch/);
    });
});
