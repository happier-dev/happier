import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { expect } from 'vitest';

import type { ScmBackend, ScmBackendContext } from '../types';
import {
    assertSnapshotHasOnlyTrackedContractPaths,
    assertNotUnsupportedResult,
    assertSupportedResult,
    assertUnsupportedResult,
    type ScmBackendCapabilityLeafPath,
    type ScmOperationResult,
} from './scmBackendContractAssertions';
import {
    createBareGitRemoteFixture,
    createScmContractTempDirectory,
    runScmExecutable,
    type ScmBackendRepositoryFixture,
} from './scmBackendContractFixtures';

export type ScmBackendContractOperationInput = Readonly<{
    backend: ScmBackend;
    context: ScmBackendContext;
    fixture: ScmBackendRepositoryFixture;
}>;

export type ScmBackendContractOperation = Readonly<{
    path: ScmBackendCapabilityLeafPath;
    assertUnsupported: (input: ScmBackendContractOperationInput) => Promise<void>;
    assertSupported?: (input: ScmBackendContractOperationInput) => Promise<void>;
}>;

async function assertFeatureUnsupported(result: Promise<ScmOperationResult>): Promise<void> {
    assertUnsupportedResult(await result);
}

function createContext(
    backend: ScmBackend,
    cwd: string,
    detection: ScmBackendContext['detection'],
): ScmBackendContext {
    return {
        cwd,
        projectKey: `${backend.id}:${cwd}`,
        detection,
    };
}

async function assertStatusSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'status-change\n');
    const status = await input.backend.statusSnapshot({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(status);
    expect(status.snapshot?.repo.backendId).toBe(input.backend.id);
    expect(status.snapshot?.entries.some((entry) => entry.path === input.fixture.trackedPath)).toBe(true);
}

async function assertRepositoryDetectionSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const detection = await input.backend.detectRepo({ cwd: input.fixture.rootPath });
    expect(detection).toMatchObject({
        isRepo: true,
        rootPath: input.fixture.rootPath,
    });
}

async function assertRepoIdentitySupported(input: ScmBackendContractOperationInput): Promise<void> {
    const status = await input.backend.statusSnapshot({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(status);
    expect(status.snapshot?.repo.rootPath).toBe(input.fixture.rootPath);
    expect(status.snapshot?.repo.backendId).toBe(input.backend.id);
}

async function assertRepoModeSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const described = await input.backend.describeBackend({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(described);
    expect(described.repoMode).toBe(input.context.detection.mode ?? undefined);
}

async function assertIgnoredPathSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const status = await input.backend.statusSnapshot({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(status);
    expect(status.snapshot?.entries.map((entry) => entry.path)).not.toContain(input.fixture.ignoredPath);
}

async function assertDiffFileSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'diff-file-change\n');
    const diff = await input.backend.diffFile({
        context: input.context,
        request: { cwd: input.fixture.rootPath, path: input.fixture.trackedPath, area: 'pending' },
    });
    assertSupportedResult(diff);
    expect(diff.diff).toContain(input.fixture.trackedPath);
}

async function assertDiffCommitSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const diff = await input.backend.diffCommit({
        context: input.context,
        request: { cwd: input.fixture.rootPath, commit: input.fixture.headCommit },
    });
    assertSupportedResult(diff);
    expect(diff.diff).toContain(input.fixture.trackedPath);
}

async function assertLogSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const log = await input.backend.logList({
        context: input.context,
        request: { cwd: input.fixture.rootPath, limit: 1 },
    });
    assertSupportedResult(log);
    expect(log.entries?.[0]?.sha).toBe(input.fixture.headCommit);
}

async function assertBranchesSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const branches = await input.backend.branchList({
        context: input.context,
        request: { cwd: input.fixture.rootPath, includeRemotes: true },
    });
    assertSupportedResult(branches);
    expect(branches.branches?.some((branch) => branch.name === input.fixture.branchName)).toBe(true);
}

async function assertStashSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const stashes = await input.backend.stashList({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(stashes);
    expect(stashes.stashes).toBeDefined();
}

async function assertIncludeSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'include-change\n');
    const include = await input.backend.changeInclude({
        context: input.context,
        request: { cwd: input.fixture.rootPath, paths: [input.fixture.trackedPath] },
    });
    assertSupportedResult(include);
}

async function assertExcludeSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'exclude-change\n');
    await input.backend.changeInclude({
        context: input.context,
        request: { cwd: input.fixture.rootPath, paths: [input.fixture.trackedPath] },
    });
    const exclude = await input.backend.changeExclude({
        context: input.context,
        request: { cwd: input.fixture.rootPath, paths: [input.fixture.trackedPath] },
    });
    assertSupportedResult(exclude);
}

async function assertDiscardSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const untrackedPath = 'discard-me.txt';
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'discard-change\n');
    writeFileSync(join(input.fixture.rootPath, untrackedPath), 'discard-new\n');
    const discard = await input.backend.changeDiscard({
        context: input.context,
        request: {
            cwd: input.fixture.rootPath,
            entries: [
                { path: input.fixture.trackedPath, kind: 'modified' },
                { path: untrackedPath, kind: 'untracked' },
            ],
        },
    });
    assertSupportedResult(discard);
    const status = await input.backend.statusSnapshot({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(status);
    const paths = status.snapshot?.entries.map((entry) => entry.path) ?? [];
    expect(paths).not.toContain(input.fixture.trackedPath);
    expect(paths).not.toContain(untrackedPath);
}

async function assertCommitCreateSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'commit-create-change\n');
    const commit = await input.backend.commitCreate({
        context: input.context,
        request: {
            cwd: input.fixture.rootPath,
            message: 'contract commit create',
            scope: { kind: 'all-pending' },
        },
    });
    assertSupportedResult(commit);
    expect(commit.commitSha).toBeTruthy();
}

async function assertCommitPathSelectionSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, 'selected.txt'), 'selected\n');
    writeFileSync(join(input.fixture.rootPath, 'unselected.txt'), 'unselected\n');
    const commit = await input.backend.commitCreate({
        context: input.context,
        request: {
            cwd: input.fixture.rootPath,
            message: 'contract path selection',
            scope: { kind: 'paths', include: ['selected.txt'] },
        },
    });
    assertSupportedResult(commit);
    const status = await input.backend.statusSnapshot({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(status);
    if (!status.snapshot) throw new Error('path selection contract expected a snapshot');
    assertSnapshotHasOnlyTrackedContractPaths(status.snapshot, {
        included: 'unselected.txt',
        excluded: 'selected.txt',
    });
}

async function assertCommitBackoutSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'backout-change\n');
    const commit = await input.backend.commitCreate({
        context: input.context,
        request: {
            cwd: input.fixture.rootPath,
            message: 'contract backout target',
            scope: { kind: 'all-pending' },
        },
    });
    assertSupportedResult(commit);
    if (!commit.commitSha) throw new Error('backout contract expected a commit sha');
    const backout = await input.backend.commitBackout({
        context: input.context,
        request: { cwd: input.fixture.rootPath, commit: commit.commitSha },
    });
    assertSupportedResult(backout);
}

async function assertDefaultBranchSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const remote = createBareGitRemoteFixture('happier-scm-contract-remote-');
    runScmExecutable(input.fixture.rootPath, 'git', ['remote', 'add', 'origin', remote.remotePath]);
    runScmExecutable(input.fixture.rootPath, 'git', ['push', '-u', 'origin', `${input.fixture.branchName}:${remote.defaultBranch}`]);
    runScmExecutable(input.fixture.rootPath, 'git', ['fetch', 'origin']);
    runScmExecutable(input.fixture.rootPath, 'git', [
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        `refs/remotes/origin/${remote.defaultBranch}`,
    ]);
    const status = await input.backend.statusSnapshot({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(status);
    expect(status.snapshot?.repo.defaultBranch).toBe(remote.defaultBranch);
}

async function assertRemoteReadSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const status = await input.backend.statusSnapshot({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(status);
    expect(status.snapshot?.repo.remotes).toBeDefined();
}

function addGitOriginRemote(input: ScmBackendContractOperationInput): ReturnType<typeof createBareGitRemoteFixture> {
    const remote = createBareGitRemoteFixture('happier-scm-contract-remote-');
    runScmExecutable(input.fixture.rootPath, 'git', ['remote', 'add', 'origin', remote.remotePath]);
    return remote;
}

function configureGitOriginTracking(input: ScmBackendContractOperationInput): ReturnType<typeof createBareGitRemoteFixture> {
    const remote = addGitOriginRemote(input);
    runScmExecutable(input.fixture.rootPath, 'git', ['push', '-u', 'origin', `${input.fixture.branchName}:${input.fixture.branchName}`]);
    return remote;
}

async function assertRemoteAddSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const remote = createBareGitRemoteFixture('happier-scm-contract-remote-add-');
    const added = await input.backend.remoteAdd({
        context: input.context,
        request: { cwd: input.fixture.rootPath, name: 'contract', fetchUrl: remote.remotePath },
    });
    assertSupportedResult(added);
    expect(added.remotes?.some((entry) => entry.name === 'contract')).toBe(true);
}

async function assertRemoteSetUrlSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const firstRemote = createBareGitRemoteFixture('happier-scm-contract-remote-set-a-');
    const secondRemote = createBareGitRemoteFixture('happier-scm-contract-remote-set-b-');
    runScmExecutable(input.fixture.rootPath, 'git', ['remote', 'add', 'contract', firstRemote.remotePath]);
    const changed = await input.backend.remoteSetUrl({
        context: input.context,
        request: { cwd: input.fixture.rootPath, name: 'contract', fetchUrl: secondRemote.remotePath },
    });
    assertSupportedResult(changed);
    expect(changed.remotes?.find((entry) => entry.name === 'contract')?.fetchUrl).toBe(secondRemote.remotePath);
}

async function assertRemoteRemoveSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const remote = createBareGitRemoteFixture('happier-scm-contract-remote-remove-');
    runScmExecutable(input.fixture.rootPath, 'git', ['remote', 'add', 'contract', remote.remotePath]);
    const removed = await input.backend.remoteRemove({
        context: input.context,
        request: { cwd: input.fixture.rootPath, name: 'contract' },
    });
    assertSupportedResult(removed);
    expect(removed.remotes?.some((entry) => entry.name === 'contract')).toBe(false);
}

async function assertRemoteFetchSupported(input: ScmBackendContractOperationInput): Promise<void> {
    configureGitOriginTracking(input);
    const fetched = await input.backend.remoteFetch({
        context: input.context,
        request: { cwd: input.fixture.rootPath, remote: 'origin' },
    });
    assertSupportedResult(fetched);
}

async function assertRemotePullSupported(input: ScmBackendContractOperationInput): Promise<void> {
    configureGitOriginTracking(input);
    const pulled = await input.backend.remotePull({
        context: input.context,
        request: { cwd: input.fixture.rootPath, remote: 'origin', branch: input.fixture.branchName },
    });
    assertSupportedResult(pulled);
}

async function assertRemotePushSupported(input: ScmBackendContractOperationInput): Promise<void> {
    configureGitOriginTracking(input);
    const pushed = await input.backend.remotePush({
        context: input.context,
        request: { cwd: input.fixture.rootPath, remote: 'origin', branch: input.fixture.branchName },
    });
    assertSupportedResult(pushed);
}

async function assertRemotePublishSupported(input: ScmBackendContractOperationInput): Promise<void> {
    addGitOriginRemote(input);
    const published = await input.backend.remotePublish({
        context: input.context,
        request: { cwd: input.fixture.rootPath, remote: 'origin' },
    });
    assertSupportedResult(published);
}

async function assertBranchCreateSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const branchName = 'contract-created';
    const created = await input.backend.branchCreate({
        context: input.context,
        request: { cwd: input.fixture.rootPath, name: branchName },
    });
    assertSupportedResult(created);
    const branches = await input.backend.branchList({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(branches);
    expect(branches.branches?.some((branch) => branch.name === branchName)).toBe(true);
}

async function assertBranchCheckoutSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const branchName = 'contract-checkout';
    runScmExecutable(input.fixture.rootPath, 'git', ['branch', branchName]);
    const checkedOut = await input.backend.branchCheckout({
        context: input.context,
        request: { cwd: input.fixture.rootPath, name: branchName, strategy: 'bring_changes' },
    });
    assertSupportedResult(checkedOut);
}

async function assertBranchMergeSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const branchName = 'contract-merge-source';
    runScmExecutable(input.fixture.rootPath, 'git', ['checkout', '-b', branchName]);
    writeFileSync(join(input.fixture.rootPath, 'merge-source.txt'), 'merge source\n');
    runScmExecutable(input.fixture.rootPath, 'git', ['add', 'merge-source.txt']);
    runScmExecutable(input.fixture.rootPath, 'git', ['commit', '-m', 'merge source']);
    runScmExecutable(input.fixture.rootPath, 'git', ['checkout', input.fixture.branchName]);
    const merged = await input.backend.branchMerge({
        context: input.context,
        request: { cwd: input.fixture.rootPath, sourceRef: branchName },
    });
    assertSupportedResult(merged);
}

async function assertBranchRebaseSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const rebased = await input.backend.branchRebase({
        context: input.context,
        request: { cwd: input.fixture.rootPath, sourceRef: input.fixture.headCommit },
    });
    assertSupportedResult(rebased);
}

async function assertBranchOperationControlSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const controlled = await input.backend.branchOperationAbort({
        context: input.context,
        request: { cwd: input.fixture.rootPath, operation: 'merge' },
    });
    expect(controlled.success).toBe(false);
    assertNotUnsupportedResult(controlled);
    expect(controlled.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_NOT_IN_PROGRESS);
}

async function assertWorktreeCreateSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const created = await input.backend.worktreeCreate({
        context: input.context,
        request: { cwd: input.fixture.rootPath, displayName: 'contract-worktree-create' },
    });
    assertSupportedResult(created);
    expect(created.worktreePath).toBeTruthy();
}

async function assertWorktreeRemoveSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const created = await input.backend.worktreeCreate({
        context: input.context,
        request: { cwd: input.fixture.rootPath, displayName: 'contract-worktree-remove' },
    });
    assertSupportedResult(created);
    const removed = await input.backend.worktreeRemove({
        context: input.context,
        request: { cwd: input.fixture.rootPath, worktreePath: created.worktreePath },
    });
    assertSupportedResult(removed);
}

async function assertWorktreePruneSupported(input: ScmBackendContractOperationInput): Promise<void> {
    const pruned = await input.backend.worktreePrune({
        context: input.context,
        request: { cwd: input.fixture.rootPath },
    });
    assertSupportedResult(pruned);
}

async function assertCommitLineSelectionSupported(input: ScmBackendContractOperationInput): Promise<void> {
    writeFileSync(join(input.fixture.rootPath, input.fixture.trackedPath), 'base\nline-one\nline-two\n');
    const diff = await input.backend.diffFile({
        context: input.context,
        request: { cwd: input.fixture.rootPath, path: input.fixture.trackedPath, area: 'pending' },
    });
    assertSupportedResult(diff);
    if (!diff.diff) throw new Error('line selection contract expected a file diff');
    const commit = await input.backend.commitCreate({
        context: input.context,
        request: {
            cwd: input.fixture.rootPath,
            message: 'contract line selection',
            patches: [{ path: input.fixture.trackedPath, patch: diff.diff }],
        },
    });
    assertSupportedResult(commit);
    expect(commit.commitSha).toBeTruthy();
}

async function assertRepositoryInitSupported(input: ScmBackendContractOperationInput): Promise<void> {
    expect(input.backend.repositoryInit).toBeTypeOf('function');
    if (!input.backend.repositoryInit) {
        throw new Error(`${input.backend.id} advertised repository init without registering the operation`);
    }
    const workspace = createScmContractTempDirectory('happier-scm-contract-init-');
    const response = await input.backend.repositoryInit({
        context: createContext(input.backend, workspace, { isRepo: false, rootPath: null, mode: null }),
        request: { cwd: workspace, initialBranch: 'contract-init' },
    });
    assertSupportedResult(response);
    expect(response.snapshot?.repo.isRepo).toBe(true);
}

async function assertRemoveIndexLockSupported(input: ScmBackendContractOperationInput): Promise<void> {
    expect(input.backend.removeIndexLock).toBeTypeOf('function');
    if (!input.backend.removeIndexLock) {
        throw new Error(`${input.backend.id} advertised index lock recovery without registering the operation`);
    }
    const response = await input.backend.removeIndexLock({
        context: input.context,
        request: {
            cwd: input.fixture.rootPath,
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        },
    });
    assertSupportedResult(response);
}

async function assertIdentityRediscoverySupported(input: ScmBackendContractOperationInput): Promise<void> {
    const detection = await input.backend.detectRepo({ cwd: input.fixture.nestedPath });
    expect(detection).toMatchObject({
        isRepo: true,
        rootPath: input.fixture.rootPath,
    });
}

async function assertWorkspaceInspectLocationSupported(input: ScmBackendContractOperationInput): Promise<void> {
    expect(input.backend.workspaceIntegration?.inspectWorkspaceLocation).toBeTypeOf('function');
    const inspection = await input.backend.workspaceIntegration?.inspectWorkspaceLocation({ context: input.context });
    expect(inspection?.rootPath).toBe(input.fixture.rootPath);
}

async function assertPortableWorkspacePathClassificationSupported(input: ScmBackendContractOperationInput): Promise<void> {
    expect(input.backend.workspaceIntegration?.classifyPortableWorkspacePath).toBeTypeOf('function');
    const classification = input.backend.workspaceIntegration?.classifyPortableWorkspacePath?.({
        relativePath: input.fixture.trackedPath,
    });
    expect(['portable', 'non_portable', 'unknown']).toContain(classification);
}

export function createScmBackendContractOperations(): readonly ScmBackendContractOperation[] {
    return [
        {
            path: { group: 'detection', leaf: 'repository' },
            assertSupported: assertRepositoryDetectionSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.statusSnapshot({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'detection', leaf: 'repoIdentity' },
            assertSupported: assertRepoIdentitySupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.statusSnapshot({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'detection', leaf: 'ignoredPath' },
            assertSupported: assertIgnoredPathSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.statusSnapshot({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'detection', leaf: 'repoMode' },
            assertSupported: assertRepoModeSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.describeBackend({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'read', leaf: 'status' },
            assertSupported: assertStatusSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.statusSnapshot({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'read', leaf: 'diffFile' },
            assertSupported: assertDiffFileSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.diffFile({
                context: input.context,
                request: { cwd: input.fixture.rootPath, path: input.fixture.trackedPath, area: 'pending' },
            })),
        },
        {
            path: { group: 'read', leaf: 'diffCommit' },
            assertSupported: assertDiffCommitSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.diffCommit({
                context: input.context,
                request: { cwd: input.fixture.rootPath, commit: input.fixture.headCommit },
            })),
        },
        {
            path: { group: 'read', leaf: 'log' },
            assertSupported: assertLogSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.logList({
                context: input.context,
                request: { cwd: input.fixture.rootPath, limit: 1 },
            })),
        },
        {
            path: { group: 'read', leaf: 'branches' },
            assertSupported: assertBranchesSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.branchList({
                context: input.context,
                request: { cwd: input.fixture.rootPath, includeRemotes: true },
            })),
        },
        {
            path: { group: 'read', leaf: 'stash' },
            assertSupported: assertStashSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.stashList({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'read', leaf: 'defaultBranch' },
            assertSupported: assertDefaultBranchSupported,
            assertUnsupported: async (input) => {
                const status = await input.backend.statusSnapshot({
                    context: input.context,
                    request: { cwd: input.fixture.rootPath },
                });
                assertSupportedResult(status);
                expect(status.snapshot?.repo.defaultBranch).toBeUndefined();
            },
        },
        {
            path: { group: 'remote', leaf: 'read' },
            assertSupported: assertRemoteReadSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.statusSnapshot({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'remote', leaf: 'add' },
            assertSupported: assertRemoteAddSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remoteAdd({
                context: input.context,
                request: { cwd: input.fixture.rootPath, name: 'contract', fetchUrl: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'remote', leaf: 'setUrl' },
            assertSupported: assertRemoteSetUrlSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remoteSetUrl({
                context: input.context,
                request: { cwd: input.fixture.rootPath, name: 'contract', fetchUrl: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'remote', leaf: 'remove' },
            assertSupported: assertRemoteRemoveSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remoteRemove({
                context: input.context,
                request: { cwd: input.fixture.rootPath, name: 'contract' },
            })),
        },
        {
            path: { group: 'remote', leaf: 'fetch' },
            assertSupported: assertRemoteFetchSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remoteFetch({
                context: input.context,
                request: { cwd: input.fixture.rootPath, remote: 'origin' },
            })),
        },
        {
            path: { group: 'remote', leaf: 'pull' },
            assertSupported: assertRemotePullSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remotePull({
                context: input.context,
                request: { cwd: input.fixture.rootPath, remote: 'origin', branch: input.fixture.branchName },
            })),
        },
        {
            path: { group: 'remote', leaf: 'push' },
            assertSupported: assertRemotePushSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remotePush({
                context: input.context,
                request: { cwd: input.fixture.rootPath, remote: 'origin', branch: input.fixture.branchName },
            })),
        },
        {
            path: { group: 'remote', leaf: 'publish' },
            assertSupported: assertRemotePublishSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remotePublish({
                context: input.context,
                request: { cwd: input.fixture.rootPath, remote: 'origin' },
            })),
        },
        {
            path: { group: 'branch', leaf: 'list' },
            assertSupported: assertBranchesSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.branchList({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'branch', leaf: 'create' },
            assertSupported: assertBranchCreateSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.branchCreate({
                context: input.context,
                request: { cwd: input.fixture.rootPath, name: 'contract-created' },
            })),
        },
        {
            path: { group: 'branch', leaf: 'checkout' },
            assertSupported: assertBranchCheckoutSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.branchCheckout({
                context: input.context,
                request: { cwd: input.fixture.rootPath, name: input.fixture.branchName, strategy: 'bring_changes' },
            })),
        },
        {
            path: { group: 'branch', leaf: 'merge' },
            assertSupported: assertBranchMergeSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.branchMerge({
                context: input.context,
                request: { cwd: input.fixture.rootPath, sourceRef: input.fixture.branchName },
            })),
        },
        {
            path: { group: 'branch', leaf: 'rebase' },
            assertSupported: assertBranchRebaseSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.branchRebase({
                context: input.context,
                request: { cwd: input.fixture.rootPath, sourceRef: input.fixture.branchName },
            })),
        },
        {
            path: { group: 'branch', leaf: 'operationControl' },
            assertSupported: assertBranchOperationControlSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.branchOperationAbort({
                context: input.context,
                request: { cwd: input.fixture.rootPath, operation: 'merge' },
            })),
        },
        {
            path: { group: 'worktree', leaf: 'create' },
            assertSupported: assertWorktreeCreateSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.worktreeCreate({
                context: input.context,
                request: { cwd: input.fixture.rootPath, displayName: 'contract-worktree' },
            })),
        },
        {
            path: { group: 'worktree', leaf: 'remove' },
            assertSupported: assertWorktreeRemoveSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.worktreeRemove({
                context: input.context,
                request: { cwd: input.fixture.rootPath, worktreePath: join(input.fixture.rootPath, 'missing-worktree') },
            })),
        },
        {
            path: { group: 'worktree', leaf: 'prune' },
            assertSupported: assertWorktreePruneSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.worktreePrune({
                context: input.context,
                request: { cwd: input.fixture.rootPath },
            })),
        },
        {
            path: { group: 'changeSet', leaf: 'include' },
            assertSupported: assertIncludeSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.changeInclude({
                context: input.context,
                request: { cwd: input.fixture.rootPath, paths: [input.fixture.trackedPath] },
            })),
        },
        {
            path: { group: 'changeSet', leaf: 'exclude' },
            assertSupported: assertExcludeSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.changeExclude({
                context: input.context,
                request: { cwd: input.fixture.rootPath, paths: [input.fixture.trackedPath] },
            })),
        },
        {
            path: { group: 'changeSet', leaf: 'discard' },
            assertSupported: assertDiscardSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.changeDiscard({
                context: input.context,
                request: { cwd: input.fixture.rootPath, entries: [{ path: input.fixture.trackedPath, kind: 'modified' }] },
            })),
        },
        {
            path: { group: 'commit', leaf: 'create' },
            assertSupported: assertCommitCreateSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.commitCreate({
                context: input.context,
                request: { cwd: input.fixture.rootPath, message: 'unsupported commit' },
            })),
        },
        {
            path: { group: 'commit', leaf: 'pathSelection' },
            assertSupported: assertCommitPathSelectionSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.commitCreate({
                context: input.context,
                request: {
                    cwd: input.fixture.rootPath,
                    message: 'unsupported path selection',
                    scope: { kind: 'paths', include: [input.fixture.trackedPath] },
                },
            })),
        },
        {
            path: { group: 'commit', leaf: 'lineSelection' },
            assertSupported: assertCommitLineSelectionSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.commitCreate({
                context: input.context,
                request: {
                    cwd: input.fixture.rootPath,
                    message: 'unsupported line selection',
                    patches: [{ path: input.fixture.trackedPath, patch: 'diff --git a/tracked.txt b/tracked.txt\n' }],
                },
            })),
        },
        {
            path: { group: 'commit', leaf: 'backout' },
            assertSupported: assertCommitBackoutSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.commitBackout({
                context: input.context,
                request: { cwd: input.fixture.rootPath, commit: input.fixture.headCommit },
            })),
        },
        {
            path: { group: 'lifecycle', leaf: 'init' },
            assertSupported: assertRepositoryInitSupported,
            assertUnsupported: async (input) => {
                expect(input.backend.repositoryInit).toBeUndefined();
            },
        },
        {
            path: { group: 'lifecycle', leaf: 'publish' },
            assertSupported: assertRemotePublishSupported,
            assertUnsupported: (input) => assertFeatureUnsupported(input.backend.remotePublish({
                context: input.context,
                request: { cwd: input.fixture.rootPath, remote: 'origin' },
            })),
        },
        {
            path: { group: 'lifecycle', leaf: 'identityRediscovery' },
            assertSupported: assertIdentityRediscoverySupported,
            assertUnsupported: async (input) => {
                expect(input.backend.detectRepo).toBeTypeOf('function');
            },
        },
        {
            path: { group: 'lifecycle', leaf: 'removeIndexLock' },
            assertSupported: assertRemoveIndexLockSupported,
            assertUnsupported: async (input) => {
                expect(input.backend.removeIndexLock).toBeUndefined();
            },
        },
        {
            path: { group: 'workspaceIntegration', leaf: 'inspectLocation' },
            assertSupported: assertWorkspaceInspectLocationSupported,
            assertUnsupported: async (input) => {
                expect(input.backend.workspaceIntegration?.inspectWorkspaceLocation).toBeUndefined();
            },
        },
        {
            path: { group: 'workspaceIntegration', leaf: 'portablePathClassification' },
            assertSupported: assertPortableWorkspacePathClassificationSupported,
            assertUnsupported: async (input) => {
                expect(input.backend.workspaceIntegration?.classifyPortableWorkspacePath).toBeUndefined();
            },
        },
    ];
}
