import { describe, expect, it } from 'vitest';

import {
    SCM_COMMIT_PATCH_MAX_COUNT,
    SCM_COMMIT_PATCH_MAX_LENGTH,
    SCM_OPERATION_ERROR_CODES,
    ScmBackendDescribeResponseSchema,
    ScmChangeDiscardRequestSchema,
    ScmChangeDiscardResponseSchema,
    ScmCommitCreateRequestSchema,
    ScmDefaultBranchPushPolicySchema,
    isScmPatchBoundToPath,
    parseScmPatchPaths,
    ScmStatusSnapshotRequestSchema,
    ScmStatusSnapshotResponseSchema,
    ScmRemoteAddRequestSchema,
    ScmRemoteRemoveRequestSchema,
    ScmRemoteSetUrlRequestSchema,
    ScmWorkingSnapshotSchema,
} from './scm.js';

describe('scm protocol contracts', () => {
    it('parses backend describe responses with capability metadata', () => {
        const parsed = ScmBackendDescribeResponseSchema.parse({
            success: true,
            backendId: 'sapling',
            repoMode: '.git',
            isRepo: true,
            capabilities: {
                readStatus: true,
                readDiffFile: true,
                readDiffCommit: true,
                readLog: true,
                writeInclude: false,
                writeExclude: false,
                writeCommit: true,
                writeCommitPathSelection: true,
                writeCommitLineSelection: false,
                writeBackout: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
                worktreeCreate: false,
                changeSetModel: 'working-copy',
                supportedDiffAreas: ['pending', 'both'],
                operationLabels: {
                    commit: 'Commit changes',
                },
            },
        });

        expect(parsed.capabilities).toBeDefined();
        if (!parsed.capabilities) {
            throw new Error('expected capabilities in backend describe response');
        }
        expect(parsed.capabilities).toBeDefined();
        expect(parsed.capabilities?.writeInclude).toBe(false);
        expect(parsed.capabilities?.changeSetModel).toBe('working-copy');
        expect(parsed.capabilities?.supportedDiffAreas).toEqual(['pending', 'both']);
        expect(parsed.capabilities?.operationLabels?.commit).toBe('Commit changes');
    });

    it('parses repository provisioning requests and responses', async () => {
        const mod = await import('./scmRepositoryProvisioning.js').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected repository provisioning protocol module');

        const initRequest = mod.ScmRepositoryInitRequestSchema.parse({
            cwd: '.',
            initialBranch: 'main',
        });
        expect(initRequest.initialBranch).toBe('main');

        const removeLockRequest = mod.ScmRepositoryRemoveIndexLockRequestSchema.parse({
            cwd: '.',
        });
        expect(removeLockRequest.cwd).toBe('.');

        const removeLockResponse = mod.ScmRepositoryRemoveIndexLockResponseSchema.parse({
            success: true,
            removed: true,
            lockPath: '/repo/.git/index.lock',
        });
        expect(removeLockResponse.success && removeLockResponse.removed).toBe(true);

        const publishRequest = mod.ScmHostingRepositoryPublishRequestSchema.parse({
            cwd: '.',
            providerKind: 'github',
            owner: 'happier-dev',
            ownerKind: 'user',
            repositoryName: 'happier',
            visibility: 'private',
            remoteName: 'origin',
            remoteConflictStrategy: 'fail',
            remoteUrlKind: 'https',
            pushCurrentBranch: true,
        });
        expect(publishRequest.remoteConflictStrategy).toBe('fail');
        expect(publishRequest.ownerKind).toBe('user');

        const missingOwnerKind = mod.ScmHostingRepositoryPublishRequestSchema.safeParse({
            cwd: '.',
            providerKind: 'github',
            owner: 'happier-dev',
            repositoryName: 'happier',
            visibility: 'private',
        });
        expect(missingOwnerKind.success).toBe(false);

        const publishTargetsResponse = mod.ScmHostingRepositoryDescribePublishTargetsResponseSchema.parse({
            success: true,
            auth: {
                kind: 'gh-cli',
                authenticated: true,
                installableKey: 'gh',
            },
            defaultRepositoryName: 'happier',
            targets: [
                {
                    providerKind: 'github',
                    owner: 'happier-dev',
                    ownerKind: 'user',
                    label: 'happier-dev',
                    default: true,
                    supportedVisibilities: ['private', 'public'],
                },
            ],
        });
        expect(publishTargetsResponse.success && publishTargetsResponse.targets[0]?.ownerKind).toBe('user');

        const publishResponse = mod.ScmHostingRepositoryPublishResponseSchema.parse({
            success: true,
            repository: {
                provider: {
                    kind: 'github',
                    name: 'GitHub',
                    baseUrl: 'https://github.com',
                    nameWithOwner: 'happier-dev/happier',
                },
                nameWithOwner: 'happier-dev/happier',
                url: 'https://github.com/happier-dev/happier',
                cloneUrl: 'https://github.com/happier-dev/happier.git',
                sshUrl: 'git@github.com:happier-dev/happier.git',
                visibility: 'private',
                defaultBranch: 'main',
            },
            remote: {
                name: 'origin',
                fetchUrl: 'https://github.com/happier-dev/happier.git',
                pushUrl: 'https://github.com/happier-dev/happier.git',
            },
            pushed: true,
        });
        expect(publishResponse.success && publishResponse.repository.visibility).toBe('private');
    });

    it('accepts the legacy workspaceWorktreeCreate capability alias', () => {
        const parsed = ScmBackendDescribeResponseSchema.parse({
            success: true,
            backendId: 'sapling',
            repoMode: '.git',
            isRepo: true,
            capabilities: {
                readStatus: true,
                readDiffFile: true,
                readDiffCommit: true,
                readLog: true,
                writeInclude: false,
                writeExclude: false,
                writeCommit: true,
                writeCommitPathSelection: true,
                writeCommitLineSelection: false,
                writeBackout: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
                workspaceWorktreeCreate: true,
                changeSetModel: 'working-copy',
                supportedDiffAreas: ['pending', 'both'],
            },
        });

        expect(parsed.capabilities?.worktreeCreate).toBe(true);
    });

    it('supports backend preference on status requests', () => {
        const parsed = ScmStatusSnapshotRequestSchema.parse({
            cwd: '.',
            backendPreference: {
                kind: 'prefer',
                backendId: 'sapling',
            },
        });

        expect(parsed.backendPreference?.backendId).toBe('sapling');
    });

    it('parses normalized working snapshots', () => {
        const snapshot = ScmWorkingSnapshotSchema.parse({
            projectKey: 'machine-1:/repo',
            fetchedAt: Date.now(),
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [
                    {
                        path: '/repo',
                        branch: 'main',
                        isCurrent: true,
                        isMain: true,
                    },
                    {
                        path: '/repo/.worktrees/feature-auth',
                        branch: 'feature/auth',
                        isCurrent: false,
                        isMain: false,
                    },
                ],
                remotes: [
                    {
                        name: 'origin',
                        fetchUrl: 'git@github.com:happier-dev/happier.git',
                        pushUrl: 'git@github.com:happier-dev/happier.git',
                    },
                ],
            },
            capabilities: {
                readStatus: true,
                readDiffFile: true,
                readDiffCommit: true,
                readLog: true,
                writeInclude: true,
                writeExclude: true,
                writeCommit: true,
                writeCommitPathSelection: true,
                writeCommitLineSelection: true,
                writeBackout: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
                readHostingProvider: true,
                readPullRequests: true,
                writePullRequestCreate: true,
                writePullRequestCheckout: true,
                writePullRequestPrepareWorktree: true,
                writePullRequestRunStacked: true,
                defaultBranchPushPolicy: 'requires-feature-branch',
                worktreeCreate: true,
                changeSetModel: 'index',
                supportedDiffAreas: ['included', 'pending', 'both'],
            },
            hostingProvider: {
                kind: 'github',
                name: 'GitHub',
                baseUrl: 'https://github.com',
                nameWithOwner: 'happier-dev/happier',
                remoteName: 'origin',
            },
            pullRequest: {
                provider: {
                    kind: 'github',
                    name: 'GitHub',
                    baseUrl: 'https://github.com',
                    nameWithOwner: 'happier-dev/happier',
                    remoteName: 'origin',
                },
                number: 42,
                title: 'Add PR support',
                url: 'https://github.com/happier-dev/happier/pull/42',
                baseBranch: 'main',
                headBranch: 'feature/pr-support',
                state: 'open',
            },
            branch: {
                head: 'main',
                upstream: 'origin/main',
                ahead: 0,
                behind: 0,
                detached: false,
            },
            hasConflicts: false,
            operationState: {
                kind: 'merge',
                sourceRef: 'feature/auth',
                canContinue: true,
                canAbort: true,
            },
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        });

        const response = ScmStatusSnapshotResponseSchema.parse({
            success: true,
            snapshot,
        });

        expect(response.snapshot?.repo.backendId).toBe('git');
        expect(response.snapshot?.repo.worktrees).toHaveLength(2);
        expect(response.snapshot?.repo.worktrees?.[1]?.branch).toBe('feature/auth');
        expect(response.snapshot?.repo.worktrees?.[0]?.isMain).toBe(true);
        expect(response.snapshot?.repo.worktrees?.[1]?.isMain).toBe(false);
        expect(response.snapshot?.capabilities.defaultBranchPushPolicy).toBe('requires-feature-branch');
        expect(response.snapshot?.hostingProvider?.kind).toBe('github');
        expect(response.snapshot?.pullRequest?.number).toBe(42);
        expect(response.snapshot?.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: 'git@github.com:happier-dev/happier.git',
                pushUrl: 'git@github.com:happier-dev/happier.git',
            },
        ]);
        expect(response.snapshot?.operationState).toEqual({
            kind: 'merge',
            sourceRef: 'feature/auth',
            canContinue: true,
            canAbort: true,
        });
        expect(response.snapshot?.totals.pendingFiles).toBe(0);
        expect(response.snapshot?.capabilities.changeSetModel).toBe('index');
        expect(response.snapshot?.capabilities.supportedDiffAreas).toEqual(['included', 'pending', 'both']);
    });

    it('parses default branch push policy values', () => {
        expect(ScmDefaultBranchPushPolicySchema.parse('allow')).toBe('allow');
        expect(ScmDefaultBranchPushPolicySchema.parse('requires-feature-branch')).toBe('requires-feature-branch');
        expect(ScmDefaultBranchPushPolicySchema.parse('deny')).toBe('deny');
    });

    it('parses remote management requests with shared safety validation', () => {
        expect(ScmRemoteAddRequestSchema.parse({
            cwd: '.',
            name: ' origin ',
            fetchUrl: ' /tmp/happier remote.git ',
            pushUrl: 'git@github.com:happier-dev/happier.git',
        })).toMatchObject({
            name: 'origin',
            fetchUrl: '/tmp/happier remote.git',
            pushUrl: 'git@github.com:happier-dev/happier.git',
        });
        expect(ScmRemoteSetUrlRequestSchema.parse({
            cwd: '.',
            name: 'origin',
            pushUrl: null,
        })).toMatchObject({
            name: 'origin',
            pushUrl: null,
        });
        expect(ScmRemoteRemoveRequestSchema.parse({
            cwd: '.',
            name: 'origin',
        })).toMatchObject({
            name: 'origin',
        });

        expect(ScmRemoteAddRequestSchema.safeParse({
            cwd: '.',
            name: '--upload-pack=hack',
            fetchUrl: '/tmp/remote.git',
        }).success).toBe(false);
        expect(ScmRemoteAddRequestSchema.safeParse({
            cwd: '.',
            name: 'origin/main',
            fetchUrl: '/tmp/remote.git',
        }).success).toBe(false);
        expect(ScmRemoteAddRequestSchema.safeParse({
            cwd: '.',
            name: 'origin',
            fetchUrl: '--upload-pack=hack',
        }).success).toBe(false);
        expect(ScmRemoteSetUrlRequestSchema.safeParse({
            cwd: '.',
            name: 'origin',
        }).success).toBe(false);
    });

    it('supports backend-native commit scope in commit create requests', () => {
        const allPending = ScmCommitCreateRequestSchema.parse({
            cwd: '.',
            message: 'Ship it',
            scope: {
                kind: 'all-pending',
            },
        });

        const pathScoped = ScmCommitCreateRequestSchema.parse({
            cwd: '.',
            message: 'Scoped commit',
            scope: {
                kind: 'paths',
                include: ['src/a.ts'],
                exclude: ['src/b.ts'],
            },
        });
        const patchScoped = ScmCommitCreateRequestSchema.parse({
            cwd: '.',
            message: 'Patch commit',
            patches: [
                {
                    path: 'src/a.ts',
                    patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
                },
            ],
        });

        expect(allPending.scope?.kind).toBe('all-pending');
        expect(pathScoped.scope?.kind).toBe('paths');
        expect(patchScoped.patches?.[0]?.path).toBe('src/a.ts');
    });

    it('supports discarding a set of pending changes', () => {
        const parsedRequest = ScmChangeDiscardRequestSchema.parse({
            cwd: '.',
            entries: [
                { path: 'src/a.ts', kind: 'modified' },
                { path: 'src/new.ts', kind: 'untracked' },
            ],
        });
        expect(parsedRequest.entries).toHaveLength(2);
        expect(parsedRequest.entries[0]?.path).toBe('src/a.ts');
        expect(parsedRequest.entries[0]?.kind).toBe('modified');

        const parsedResponse = ScmChangeDiscardResponseSchema.parse({
            success: true,
            stdout: '',
            stderr: '',
        });
        expect(parsedResponse.success).toBe(true);
    });

    it('enforces commit patch count and size limits', () => {
        const oversizedPatch = ScmCommitCreateRequestSchema.safeParse({
            cwd: '.',
            message: 'Patch commit',
            patches: [{ path: 'src/a.ts', patch: 'x'.repeat(SCM_COMMIT_PATCH_MAX_LENGTH + 1) }],
        });
        expect(oversizedPatch.success).toBe(false);

        const tooManyPatches = ScmCommitCreateRequestSchema.safeParse({
            cwd: '.',
            message: 'Patch commit',
            patches: Array.from({ length: SCM_COMMIT_PATCH_MAX_COUNT + 1 }, (_, index) => ({
                path: `src/${index}.ts`,
                patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
            })),
        });
        expect(tooManyPatches.success).toBe(false);
    });

    it('extracts patch header paths and validates declared path binding', () => {
        const singleFilePatch = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 123..456 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');
        expect(parseScmPatchPaths(singleFilePatch)).toEqual(['src/a.ts']);
        expect(isScmPatchBoundToPath('src/a.ts', singleFilePatch)).toBe(true);
        expect(isScmPatchBoundToPath('src/b.ts', singleFilePatch)).toBe(false);

        const multiFilePatch = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            'diff --git a/src/b.ts b/src/b.ts',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');
        expect(isScmPatchBoundToPath('src/a.ts', multiFilePatch)).toBe(false);
    });

    it('accepts deterministic unsupported feature errors', () => {
        const parsed = ScmStatusSnapshotResponseSchema.parse({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            error: 'The selected backend does not support include/exclude operations',
        });

        expect(parsed.success).toBe(false);
        expect(parsed.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    });
});
