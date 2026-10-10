import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScmRepoMode } from '@happier-dev/protocol';
import { GIT_SCM_BACKEND_CAPABILITIES } from '@happier-dev/plugins-scm-git';
import { SAPLING_SCM_BACKEND_CAPABILITIES } from '@happier-dev/plugins-scm-sapling';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { expect } from 'vitest';

import { assertSupportedResult, assertUnsupportedResult, type ScmOperationResult } from './scmBackendContractAssertions';
import {
    type ScmBackendContractLeafAccount,
    scmCapabilityPathKey,
} from './scmBackendContractCoverage';
import {
    createScmBackendContractOperations,
    type ScmBackendContractOperation,
    type ScmBackendContractOperationInput,
} from './scmBackendContractCases';
import { createBareGitRemoteFixture, runScmExecutable } from './scmBackendContractFixtures';

function requireMethod<T>(method: T | undefined): T {
    expect(method).toBeTypeOf('function');
    if (method === undefined) throw new Error('Declared SCM capability requires a backend method');
    return method;
}

function git(input: ScmBackendContractOperationInput, ...args: string[]): string {
    return runScmExecutable(input.fixture.rootPath, 'git', args);
}

async function commitChange(input: ScmBackendContractOperationInput): Promise<string> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'contract commit change\n');
    const result = await input.backend.commitCreate({
        context: input.context,
        request: { message: 'contract change', scope: { kind: 'all-pending' } },
    });
    assertSupportedResult(result);
    if (!result.commitSha) throw new Error('Commit contract requires a commit object');
    return result.commitSha;
}

function prepareRemote(input: ScmBackendContractOperationInput): string {
    const remote = createBareGitRemoteFixture('happier-scm-contract-policy-');
    git(input, 'remote', 'add', 'origin', remote.remotePath);
    git(input, 'push', '-u', 'origin', `${input.fixture.branchName}:${input.fixture.branchName}`);
    return remote.remotePath;
}

function prepareConflictingBranches(input: ScmBackendContractOperationInput, paths: readonly string[]): string {
    for (const path of paths) writeFileSync(join(input.fixture.rootPath, path), 'base\n');
    git(input, 'add', '--', ...paths);
    // A second conflict path is new; commit it before both branches diverge.
    if (git(input, 'diff', '--cached', '--name-only')) git(input, 'commit', '-m', 'conflict base');
    const topic = 'contract-conflicting-topic';
    git(input, 'checkout', '-b', topic);
    for (const path of paths) writeFileSync(join(input.fixture.rootPath, path), 'topic\n');
    git(input, 'commit', '-am', 'topic change');
    const topicOid = git(input, 'rev-parse', 'HEAD');
    git(input, 'checkout', input.fixture.branchName);
    for (const path of paths) writeFileSync(join(input.fixture.rootPath, path), 'target\n');
    git(input, 'commit', '-am', 'target change');
    return topicOid;
}

function executableOperation(
    path: ScmBackendContractLeafAccount['path'],
    invoke: (input: ScmBackendContractOperationInput) => Promise<ScmOperationResult>,
    assertSupported: NonNullable<ScmBackendContractLeafAccount['assertSupported']>,
): ScmBackendContractLeafAccount {
    return {
        path,
        kind: 'executable',
        assertUnsupported: async (input) => assertUnsupportedResult(await invoke(input)),
        assertSupported,
    };
}

function createGitOperationAccounts(): readonly ScmBackendContractLeafAccount[] {
    return [
        executableOperation({ group: 'read', leaf: 'historyEntries' },
            (input) => requireMethod(input.backend.historyEntries)({ context: input.context,
                request: { cwd: input.fixture.rootPath, folder: '', paths: [input.fixture.trackedPath] } }),
            async (input) => {
                const result = await requireMethod(input.backend.historyEntries)({ context: input.context,
                    request: { cwd: input.fixture.rootPath, folder: '', paths: [input.fixture.trackedPath, 'not-committed'] } });
                assertSupportedResult(result);
                expect(result).toMatchObject({ headOid: input.fixture.headCommit, entries: [
                    { path: input.fixture.trackedPath, kind: 'commit', commit: { oid: input.fixture.headCommit } },
                    { path: 'not-committed', kind: 'none' },
                ] });
            }),
        executableOperation({ group: 'changeSet', leaf: 'stashCreate' },
            (input) => requireMethod(input.backend.stashCreate)({ context: input.context, request: { message: 'contract stash' } }),
            async (input) => {
                writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'stashed change\n');
                const create = requireMethod(input.backend.stashCreate);
                const result = await create({ context: input.context, request: { message: 'contract stash' } });
                assertSupportedResult(result);
                expect(result.stashCreated).toBe(true);
                expect(result.stashOid).toBe(git(input, 'rev-parse', 'refs/stash'));
                expect(git(input, 'status', '--porcelain')).toBe('');
                const noChanges = await create({ context: input.context, request: { message: 'empty stash' } });
                expect(noChanges).toMatchObject({ success: true, stashCreated: false, stashRef: null });
                expect(git(input, 'stash', 'list', '--format=%H')).toBe(result.stashOid);
            }),
        executableOperation({ group: 'commit', leaf: 'undoLast' },
            (input) => requireMethod(input.backend.commitUndoLast)({ context: input.context, request: { expectedHeadOid: input.fixture.headCommit } }),
            async (input) => {
                const committedOid = await commitChange(input);
                const undo = requireMethod(input.backend.commitUndoLast);
                const stale = await undo({ context: input.context, request: { expectedHeadOid: input.fixture.headCommit } });
                expect(stale).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_HEAD_CHANGED });
                expect(git(input, 'rev-parse', 'HEAD')).toBe(committedOid);
                writeFileSync(join(input.fixture.rootPath, 'staged.txt'), 'staged\n');
                git(input, 'add', 'staged.txt');
                writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'unstaged\n');
                const indexTree = git(input, 'write-tree');
                const result = await undo({ context: input.context, request: { expectedHeadOid: committedOid } });
                assertSupportedResult(result);
                expect(git(input, 'rev-parse', 'HEAD')).toBe(input.fixture.headCommit);
                expect(git(input, 'write-tree')).toBe(indexTree);
                expect(readFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'utf8')).toBe('unstaged\n');
            }),
        executableOperation({ group: 'commit', leaf: 'amend' },
            (input) => input.backend.commitCreate({ context: input.context, request: { message: 'amended', mode: 'amend' } }),
            async (input) => {
                const tree = git(input, 'rev-parse', 'HEAD^{tree}');
                writeFileSync(join(input.fixture.rootPath, 'staged.txt'), 'staged\n');
                git(input, 'add', 'staged.txt');
                writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'unstaged\n');
                const result = await input.backend.commitCreate({ context: input.context, request: { message: 'contract amended', mode: 'amend' } });
                assertSupportedResult(result);
                expect(git(input, 'log', '-1', '--format=%s')).toBe('contract amended');
                expect(git(input, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
                expect(git(input, 'rev-list', '--count', 'HEAD')).toBe('1');
                expect(git(input, 'diff', '--cached', '--name-only')).toBe('staged.txt');
                expect(readFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'utf8')).toBe('unstaged\n');
            }),
        executableOperation({ group: 'commit', leaf: 'signOff' },
            (input) => input.backend.commitCreate({ context: input.context, request: { message: 'sign off', signOff: true } }),
            async (input) => {
                writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'signed off\n');
                const result = await input.backend.commitCreate({ context: input.context, request: { message: 'contract sign off', signOff: true, scope: { kind: 'all-pending' } } });
                assertSupportedResult(result);
                const identity = `${git(input, 'config', 'user.name')} <${git(input, 'config', 'user.email')}>`;
                expect(git(input, 'log', '-1', '--format=%B')).toContain(`Signed-off-by: ${identity}`);
            }),
        executableOperation({ group: 'commit', leaf: 'safePlan' },
            (input) => input.backend.commitCreate({ context: input.context, request: { message: 'planned', expectedHeadOid: input.fixture.headCommit, expectedRef: `refs/heads/${input.fixture.branchName}`, expectedCandidateTreeOid: input.fixture.headCommit } }),
            async (input) => {
                const expectedRef = `refs/heads/${input.fixture.branchName}`;
                const originalTree = git(input, 'rev-parse', 'HEAD^{tree}');
                writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'planned change\n');
                git(input, 'add', input.fixture.trackedPath);
                const candidateTree = git(input, 'write-tree');
                const refused = await input.backend.commitCreate({ context: input.context, request: {
                    message: 'wrong reviewed tree', expectedHeadOid: input.fixture.headCommit, expectedRef,
                    expectedCandidateTreeOid: originalTree,
                } });
                expect(refused).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, publication: { state: 'not_published' } });
                expect(git(input, 'rev-parse', 'HEAD')).toBe(input.fixture.headCommit);
                expect(git(input, 'write-tree')).toBe(candidateTree);
                const committed = await input.backend.commitCreate({ context: input.context, request: {
                    message: 'reviewed tree', expectedHeadOid: input.fixture.headCommit, expectedRef,
                    expectedCandidateTreeOid: candidateTree, preparedTreeOid: candidateTree,
                } });
                assertSupportedResult(committed);
                expect(committed.publication).toMatchObject({ state: 'published', expectedHeadOid: input.fixture.headCommit, expectedRef });
                expect(git(input, 'rev-parse', 'HEAD^{tree}')).toBe(candidateTree);
            }),
        executableOperation({ group: 'commit', leaf: 'resolveOutcome' },
            (input) => requireMethod(input.backend.commitResolveOutcome)({ context: input.context, request: { candidateOid: input.fixture.headCommit, expectedHeadOid: null, expectedRef: `refs/heads/${input.fixture.branchName}` } }),
            async (input) => {
                const candidateOid = await commitChange(input);
                const before = git(input, 'status', '--porcelain');
                const result = await requireMethod(input.backend.commitResolveOutcome)({ context: input.context, request: {
                    candidateOid, expectedHeadOid: input.fixture.headCommit, expectedRef: `refs/heads/${input.fixture.branchName}`,
                } });
                assertSupportedResult(result);
                expect(result.publication).toMatchObject({ state: 'published', candidateOid, indexReconciliation: 'pending' });
                expect(result.candidateTreeOid).toBe(git(input, 'rev-parse', 'HEAD^{tree}'));
                expect(git(input, 'rev-parse', 'HEAD')).toBe(candidateOid);
                expect(git(input, 'status', '--porcelain')).toBe(before);
            }),
        executableOperation({ group: 'remote', leaf: 'policies' },
            (input) => input.backend.remotePull({ context: input.context, request: { remote: 'origin', dirtyPolicy: 'allow_git' } }),
            async (input) => {
                prepareRemote(input);
                writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'local dirt\n');
                const refused = await input.backend.remotePull({ context: input.context, request: { remote: 'origin', branch: input.fixture.branchName } });
                expect(refused).toMatchObject({ success: false, outcome: { kind: 'needs_input', nextActions: [{ kind: 'choose_dirty_policy' }] } });
                expect(git(input, 'rev-parse', 'HEAD')).toBe(input.fixture.headCommit);
                const allowed = await input.backend.remotePull({ context: input.context, request: { remote: 'origin', branch: input.fixture.branchName, dirtyPolicy: 'allow_git' } });
                assertSupportedResult(allowed);
                expect(readFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'utf8')).toBe('local dirt\n');
                expect(git(input, 'stash', 'list')).toBe('');
            }),
        executableOperation({ group: 'remote', leaf: 'forceWithLease' },
            (input) => input.backend.remotePush({ context: input.context, request: { remote: 'origin', pushMode: 'force_with_lease', expectedRemoteOid: input.fixture.headCommit } }),
            async (input) => {
                const remotePath = prepareRemote(input);
                const amended = await input.backend.commitCreate({ context: input.context, request: { message: 'leased rewrite', mode: 'amend', allowPublishedAmend: true } });
                assertSupportedResult(amended);
                const rewrittenOid = git(input, 'rev-parse', 'HEAD');
                const accepted = await input.backend.remotePush({ context: input.context, request: { remote: 'origin', branch: input.fixture.branchName, pushMode: 'force_with_lease', expectedRemoteOid: input.fixture.headCommit } });
                assertSupportedResult(accepted);
                const remoteRef = `refs/heads/${input.fixture.branchName}`;
                expect(runScmExecutable(remotePath, 'git', ['rev-parse', remoteRef])).toBe(rewrittenOid);
                await commitChange(input);
                const stale = await input.backend.remotePush({ context: input.context, request: { remote: 'origin', branch: input.fixture.branchName, pushMode: 'force_with_lease', expectedRemoteOid: input.fixture.headCommit } });
                expect(stale).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD, outcome: { kind: 'needs_input' } });
                expect(runScmExecutable(remotePath, 'git', ['rev-parse', remoteRef])).toBe(rewrittenOid);
            }),
        executableOperation({ group: 'branch', leaf: 'operationSkip' },
            (input) => requireMethod(input.backend.branchOperationSkip)({ context: input.context, request: { operation: 'rebase' } }),
            async (input) => {
                const topicOid = prepareConflictingBranches(input, [input.fixture.trackedPath]);
                const rebased = await input.backend.branchRebase({ context: input.context, request: { sourceRef: 'contract-conflicting-topic' } });
                expect(rebased).toMatchObject({ success: false, operationState: { kind: 'rebase', unresolvedCount: 1 } });
                const skipped = await requireMethod(input.backend.branchOperationSkip)({ context: input.context, request: { operation: 'rebase' } });
                expect(skipped).toMatchObject({ success: true, operationState: null });
                expect(git(input, 'rev-parse', 'HEAD')).toBe(topicOid);
                expect(git(input, 'status', '--porcelain')).toBe('');
            }),
        executableOperation({ group: 'branch', leaf: 'conflictResolution' },
            (input) => requireMethod(input.backend.conflictMarkResolved)({ context: input.context, request: { paths: [input.fixture.trackedPath] } }),
            async (input) => {
                const secondPath = 'contract-second-conflict.txt';
                prepareConflictingBranches(input, [input.fixture.trackedPath, secondPath]);
                const merged = await input.backend.branchMerge({ context: input.context, request: { sourceRef: 'contract-conflicting-topic' } });
                expect(merged).toMatchObject({ success: false, operationState: { kind: 'merge', unresolvedCount: 2 } });
                const accepted = await requireMethod(input.backend.conflictAcceptSide)({ context: input.context, request: { path: input.fixture.trackedPath, side: 'theirs' } });
                assertSupportedResult(accepted);
                expect(readFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'utf8')).toBe('topic\n');
                expect(accepted.operationState).toMatchObject({ unresolvedCount: 1, canContinue: false });
                writeFileSync(join(input.fixture.rootPath, secondPath), 'reviewed\n');
                const resolved = await requireMethod(input.backend.conflictMarkResolved)({ context: input.context, request: { paths: [secondPath] } });
                assertSupportedResult(resolved);
                expect(resolved.operationState).toMatchObject({ unresolvedCount: 0, canContinue: true });
                expect(git(input, 'show', `:${secondPath}`)).toBe('reviewed');
            }),
        executableOperation({ group: 'hosting', leaf: 'pullRequestDraftCreate' },
            (input) => requireMethod(input.backend.pullRequestOpenOrReuse)({ context: input.context, request: { base: 'contract-base', head: input.fixture.branchName, draft: true } }),
            async (input) => {
                // A local repository has no admitted hosting provider. Draft creation
                // must refuse before publication; provider transport success is not claimed here.
                const before = git(input, 'status', '--porcelain');
                const result = await requireMethod(input.backend.pullRequestOpenOrReuse)({ context: input.context, request: { base: 'contract-base', head: input.fixture.branchName, draft: true } });
                assertUnsupportedResult(result);
                expect(git(input, 'rev-parse', 'HEAD')).toBe(input.fixture.headCommit);
                expect(git(input, 'status', '--porcelain')).toBe(before);
                expect(git(input, 'remote')).toBe('');
            }),
    ];
}

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
    const capabilities = input.repoMode === '.git'
        ? GIT_SCM_BACKEND_CAPABILITIES
        : SAPLING_SCM_BACKEND_CAPABILITIES;
    const executableAccounts = createScmBackendContractOperations(capabilities)
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
        ...(input.repoMode === '.git' ? createGitOperationAccounts() : []),
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
