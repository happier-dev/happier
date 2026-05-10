import type { ScmRepoMode } from '@happier-dev/protocol';
import { expect } from 'vitest';

import { assertUnsupportedResult } from './scmBackendContractAssertions';
import {
    type ScmBackendContractLeafAccount,
    scmCapabilityPathKey,
} from './scmBackendContractCoverage';
import {
    createScmBackendContractOperations,
    type ScmBackendContractOperation,
} from './scmBackendContractCases';

const RATIONALES = {
    executableAvailability: 'Executable availability is asserted once by the harness before repository operations run.',
    hostingAdapter: 'Hosting adapter behavior is intentionally out of scope for local backend contracts.',
    checkpointApi: 'Checkpoint leaves are declared as backend capabilities but do not have ScmBackend methods in this packet.',
    workspaceNoMethod: 'This workspaceIntegration leaf has no direct ScmBackend operation in this packet.',
    toolingProjection: 'Tooling leaves describe backend resolution policy rather than a per-repository backend method.',
    freshnessProjection: 'Freshness leaves describe capability metadata and are asserted through grouped capability parsing.',
    cloneHosting: 'Repository clone currently depends on a hosting-provider descriptor and is out of local backend contract scope.',
    saplingRemoteTransport: 'Sapling remote transport needs a dedicated lightweight remote fixture in a later packet.',
} as const;

function noBackendMethod(path: ScmBackendContractLeafAccount['path'], rationale: string): ScmBackendContractLeafAccount {
    return { path, kind: 'no-backend-method', rationale };
}

function blocked(path: ScmBackendContractLeafAccount['path'], rationale: string): ScmBackendContractLeafAccount {
    return { path, kind: 'blocked', rationale };
}

function accountForOperation(
    operation: ScmBackendContractOperation,
    input: Readonly<{ repoMode: ScmRepoMode }>,
): ScmBackendContractLeafAccount {
    if (input.repoMode === '.sl' && SAPLING_UNSUPPORTED_METHOD_LEAF_KEYS.has(scmCapabilityPathKey(operation.path))) {
        return {
            ...operation,
            kind: 'unsupported-method',
            requiresExecutable: false,
        };
    }

    return {
        ...operation,
        kind: 'executable',
    };
}

function shouldUseExecutableOperation(input: Readonly<{
    repoMode: ScmRepoMode;
    account: ScmBackendContractLeafAccount;
}>): boolean {
    const key = scmCapabilityPathKey(input.account.path);
    return true;
}

const SAPLING_UNSUPPORTED_METHOD_LEAF_KEYS = new Set([
    'read.branches',
    'read.stash',
    'changeSet.include',
    'changeSet.exclude',
    'commit.lineSelection',
    'remote.add',
    'remote.setUrl',
    'remote.remove',
    'remote.fetch',
    'remote.pull',
    'remote.push',
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
]);

function saplingUnsupportedMethod(
    path: ScmBackendContractLeafAccount['path'],
    assertUnsupported: NonNullable<ScmBackendContractLeafAccount['assertUnsupported']>,
): ScmBackendContractLeafAccount {
    return {
        path,
        kind: 'unsupported-method',
        requiresExecutable: false,
        assertUnsupported,
    };
}

function createSaplingUnsupportedHostingMethodAccounts(): readonly ScmBackendContractLeafAccount[] {
    return [
        saplingUnsupportedMethod({ group: 'hosting', leaf: 'pullRequestRead' }, async (input) => {
            expect(input.backend.pullRequestList).toBeTypeOf('function');
            expect(input.backend.pullRequestGet).toBeTypeOf('function');
            if (!input.backend.pullRequestList || !input.backend.pullRequestGet) return;

            assertUnsupportedResult(await input.backend.pullRequestList({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            }));
            assertUnsupportedResult(await input.backend.pullRequestGet({
                context: input.context,
                request: { cwd: input.fixture.rootPath, prReference: { number: 1 } },
            }));
        }),
        saplingUnsupportedMethod({ group: 'hosting', leaf: 'pullRequestCreate' }, async (input) => {
            expect(input.backend.pullRequestOpenCompose).toBeTypeOf('function');
            if (!input.backend.pullRequestOpenCompose) return;

            assertUnsupportedResult(await input.backend.pullRequestOpenCompose({
                context: input.context,
                request: {
                    cwd: input.fixture.rootPath,
                    base: 'contract-base',
                    head: 'contract-head',
                },
            }));
        }),
    ];
}

export function createScmBackendCapabilityLeafAccounts(input: Readonly<{
    repoMode: ScmRepoMode;
}>): readonly ScmBackendContractLeafAccount[] {
    const executableAccounts = createScmBackendContractOperations()
        .map((operation) => accountForOperation(operation, input))
        .filter((account) => shouldUseExecutableOperation({ repoMode: input.repoMode, account }));
    const saplingUnsupportedHostingMethodAccounts = input.repoMode === '.sl'
        ? createSaplingUnsupportedHostingMethodAccounts()
        : [];
    const blockedHostingLeaves = new Set(
        saplingUnsupportedHostingMethodAccounts.map((account) => scmCapabilityPathKey(account.path)),
    );

    return [
        ...executableAccounts,
        ...saplingUnsupportedHostingMethodAccounts,
        noBackendMethod({ group: 'detection', leaf: 'executable' }, RATIONALES.executableAvailability),
        blocked({ group: 'read', leaf: 'hostingProvider' }, RATIONALES.hostingAdapter),
        blocked({ group: 'read', leaf: 'pullRequestStatus' }, RATIONALES.hostingAdapter),
        blocked({ group: 'lifecycle', leaf: 'clone' }, RATIONALES.cloneHosting),
        blocked({ group: 'hosting', leaf: 'providerDetection' }, RATIONALES.hostingAdapter),
        blocked({ group: 'hosting', leaf: 'repositoryPublishTargets' }, RATIONALES.hostingAdapter),
        blocked({ group: 'hosting', leaf: 'repositoryPublish' }, RATIONALES.hostingAdapter),
        ...(blockedHostingLeaves.has('hosting.pullRequestRead')
            ? []
            : [blocked({ group: 'hosting', leaf: 'pullRequestRead' }, RATIONALES.hostingAdapter)]),
        blocked({ group: 'hosting', leaf: 'pullRequestStatus' }, RATIONALES.hostingAdapter),
        ...(blockedHostingLeaves.has('hosting.pullRequestCreate')
            ? []
            : [blocked({ group: 'hosting', leaf: 'pullRequestCreate' }, RATIONALES.hostingAdapter)]),
        blocked({ group: 'hosting', leaf: 'pullRequestReuse' }, RATIONALES.hostingAdapter),
        blocked({ group: 'hosting', leaf: 'pullRequestCheckout' }, RATIONALES.hostingAdapter),
        blocked({ group: 'hosting', leaf: 'pullRequestPrepareWorktree' }, RATIONALES.hostingAdapter),
        blocked({ group: 'hosting', leaf: 'pullRequestRunStacked' }, RATIONALES.hostingAdapter),
        noBackendMethod({ group: 'worktree', leaf: 'prepare' }, RATIONALES.workspaceNoMethod),
        noBackendMethod({ group: 'checkpoints', leaf: 'capture' }, RATIONALES.checkpointApi),
        noBackendMethod({ group: 'checkpoints', leaf: 'aliasFinalize' }, RATIONALES.checkpointApi),
        noBackendMethod({ group: 'checkpoints', leaf: 'diff' }, RATIONALES.checkpointApi),
        noBackendMethod({ group: 'checkpoints', leaf: 'cleanup' }, RATIONALES.checkpointApi),
        noBackendMethod({ group: 'checkpoints', leaf: 'backup' }, RATIONALES.checkpointApi),
        noBackendMethod({ group: 'checkpoints', leaf: 'rollbackApply' }, RATIONALES.checkpointApi),
        noBackendMethod({ group: 'workspaceIntegration', leaf: 'checkoutMaterialization' }, RATIONALES.workspaceNoMethod),
        noBackendMethod({ group: 'workspaceIntegration', leaf: 'workspaceTransfer' }, RATIONALES.workspaceNoMethod),
        noBackendMethod({ group: 'workspaceIntegration', leaf: 'exportPortability' }, RATIONALES.workspaceNoMethod),
        noBackendMethod({ group: 'tooling', leaf: 'systemCliResolution' }, RATIONALES.toolingProjection),
        noBackendMethod({ group: 'tooling', leaf: 'managedCliResolution' }, RATIONALES.toolingProjection),
        noBackendMethod({ group: 'tooling', leaf: 'binarySafe' }, RATIONALES.toolingProjection),
        noBackendMethod({ group: 'freshness', leaf: 'observed' }, RATIONALES.freshnessProjection),
        noBackendMethod({ group: 'freshness', leaf: 'expiry' }, RATIONALES.freshnessProjection),
    ];
}
