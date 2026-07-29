import { describe, expect, it } from 'vitest';

import * as scmContractModule from './index.js';
import {
    SCM_WORKTREES_ENRICHMENT_MAX_PATHS,
    SCM_COMMIT_PATCH_MAX_COUNT,
    SCM_COMMIT_PATCH_MAX_LENGTH,
    SCM_OPERATION_ERROR_CODES,
    ScmBackendDescribeResponseSchema,
    ScmChangeApplyRequestSchema,
    ScmChangeDiscardRequestSchema,
    ScmChangeDiscardResponseSchema,
    ScmCommitCreateRequestSchema,
    isScmPatchBoundToPath,
    parseScmPatchPaths,
    ScmStatusSnapshotRequestSchema,
    ScmStatusSnapshotResponseSchema,
    ScmWorktreesEnrichmentRequestSchema,
    ScmWorktreesEnrichmentResponseSchema,
    ScmWorkingSnapshotSchema,
} from './index.js';

type ZodLikeSchema<TValue = unknown> = {
    parse: (value: unknown) => TValue;
    safeParse: (value: unknown) => { success: boolean };
};

function readScmSchema<TValue = unknown>(name: string): ZodLikeSchema<TValue> {
    const value = (scmContractModule as Record<string, unknown>)[name];
    expect(value).toMatchObject({
        parse: expect.any(Function),
        safeParse: expect.any(Function),
    });
    return value as ZodLikeSchema<TValue>;
}

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

    it('supports opt-in per-worktree status enrichment on status requests', () => {
        const parsed = ScmStatusSnapshotRequestSchema.parse({
            cwd: '.',
            includeWorktreeStatus: true,
        });

        expect(parsed.includeWorktreeStatus).toBe(true);
    });

    it('supports authored external SCM backend ids in backend contracts', () => {
        const statusRequest = ScmStatusSnapshotRequestSchema.parse({
            cwd: '.',
            backendPreference: {
                kind: 'prefer',
                backendId: 'acme-vcs',
            },
        });
        const describeResponse = ScmBackendDescribeResponseSchema.parse({
            success: true,
            backendId: 'acme-vcs',
            repoMode: '.git',
            isRepo: true,
        });

        expect(statusRequest.backendPreference?.backendId).toBe('acme-vcs');
        expect(describeResponse.backendId).toBe('acme-vcs');
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
                defaultBranch: 'release/2026',
                worktrees: [
                    {
                        id: 'gitwt_main',
                        path: '/repo',
                        branch: 'main',
                        isCurrent: true,
                        isMain: true,
                        changeCount: 2,
                        lastActivityAt: 1710000000000,
                    },
                    {
                        id: 'gitwt_feature_auth',
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
                worktreeCreate: true,
                changeSetModel: 'index',
                supportedDiffAreas: ['included', 'pending', 'both'],
            },
            branch: {
                head: 'main',
                upstream: 'origin/main',
                ahead: 0,
                behind: 0,
                detached: false,
            },
            operationState: {
                kind: 'merge',
                sourceRef: 'feature/auth',
                canContinue: true,
                canAbort: true,
            },
            hasConflicts: false,
            hostingProvider: {
                id: 'scm.github',
                kind: 'github',
                displayName: 'GitHub',
                baseUrl: 'https://github.com',
                nameWithOwner: 'happier-dev/happier',
                remoteName: 'origin',
            },
            pullRequestStatus: {
                provider: {
                    id: 'scm.github',
                    kind: 'github',
                    displayName: 'GitHub',
                    baseUrl: 'https://github.com',
                    nameWithOwner: 'happier-dev/happier',
                    remoteName: 'origin',
                },
                headBranch: 'main',
                baseBranch: 'origin/main',
                openPullRequest: null,
                composeUrl: 'https://github.com/happier-dev/happier/compare/origin/main...main',
                authState: 'unknown',
                checkedAt: 123,
                cacheTtlMs: 30000,
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
        expect(response.snapshot?.repo.defaultBranch).toBe('release/2026');
        expect(response.snapshot?.repo.worktrees).toHaveLength(2);
        expect(response.snapshot?.repo.worktrees?.[1]?.branch).toBe('feature/auth');
        expect(response.snapshot?.repo.worktrees?.[0]?.isMain).toBe(true);
        expect(response.snapshot?.repo.worktrees?.[0]?.changeCount).toBe(2);
        expect(response.snapshot?.repo.worktrees?.[0]?.lastActivityAt).toBe(1710000000000);
        expect(response.snapshot?.repo.worktrees?.[1]?.isMain).toBe(false);
        expect(response.snapshot?.repo.worktrees?.[1]?.isPrunable).toBeUndefined();
        expect(response.snapshot?.repo).toMatchObject({
            remotes: [
                {
                    name: 'origin',
                    fetchUrl: 'git@github.com:happier-dev/happier.git',
                    pushUrl: 'git@github.com:happier-dev/happier.git',
                },
            ],
        });
        expect(response.snapshot?.operationState).toEqual({
            kind: 'merge',
            sourceRef: 'feature/auth',
            canContinue: true,
            canAbort: true,
        });
        expect(response.snapshot?.hostingProvider).toMatchObject({
            id: 'scm.github',
            kind: 'github',
            nameWithOwner: 'happier-dev/happier',
        });
        expect(response.snapshot?.pullRequestStatus).toMatchObject({
            headBranch: 'main',
            baseBranch: 'origin/main',
            composeUrl: 'https://github.com/happier-dev/happier/compare/origin/main...main',
        });
        expect(response.snapshot?.totals.pendingFiles).toBe(0);
        expect(response.snapshot?.capabilities.changeSetModel).toBe('index');
        expect(response.snapshot?.capabilities.supportedDiffAreas).toEqual(['included', 'pending', 'both']);
    });

    it('validates pull-request status projection with the canonical pull-request schema', () => {
        const result = ScmWorkingSnapshotSchema.safeParse({
            projectKey: 'machine-1:/repo',
            fetchedAt: 123,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [],
                remotes: [],
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
                worktreeCreate: true,
                changeSetModel: 'index',
                supportedDiffAreas: ['included', 'pending', 'both'],
            },
            branch: {
                head: 'feature/pr-cache',
                upstream: 'origin/main',
                ahead: 0,
                behind: 0,
                detached: false,
            },
            hasConflicts: false,
            pullRequestStatus: {
                provider: {
                    id: 'scm.github',
                    kind: 'github',
                    displayName: 'GitHub',
                    baseUrl: 'https://github.com',
                    nameWithOwner: 'happier-dev/happier',
                    remoteName: 'origin',
                },
                headBranch: 'feature/pr-cache',
                baseBranch: 'main',
                openPullRequest: {
                    provider: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'GitHub',
                        baseUrl: 'https://github.com',
                        nameWithOwner: 'happier-dev/happier',
                        remoteName: 'origin',
                    },
                    number: 42,
                    url: 'https://github.com/happier-dev/happier/pull/42',
                    baseBranch: 'main',
                    headBranch: 'feature/pr-cache',
                    state: 'open',
                },
                authState: 'authenticated',
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

        expect(result.success).toBe(false);
    });

    it('defaults omitted working snapshot remotes to an empty list', () => {
        const snapshot = ScmWorkingSnapshotSchema.parse({
            projectKey: 'machine-1:/repo',
            fetchedAt: Date.now(),
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
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
                worktreeCreate: true,
                changeSetModel: 'index',
                supportedDiffAreas: ['included', 'pending', 'both'],
            },
            branch: {
                head: 'main',
                upstream: null,
                ahead: 0,
                behind: 0,
                detached: false,
            },
            hasConflicts: false,
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

        expect(snapshot.repo).toMatchObject({ remotes: [] });
    });

    it('parses remote management requests with shared safety validation', () => {
        const ScmRemoteAddRequestSchema = readScmSchema('ScmRemoteAddRequestSchema');
        const ScmRemoteSetUrlRequestSchema = readScmSchema('ScmRemoteSetUrlRequestSchema');
        const ScmRemoteRemoveRequestSchema = readScmSchema('ScmRemoteRemoveRequestSchema');

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

    it('parses branch integration and operation-control requests', () => {
        const ScmBranchIntegrationRequestSchema = readScmSchema('ScmBranchIntegrationRequestSchema');
        const ScmBranchOperationControlRequestSchema = readScmSchema('ScmBranchOperationControlRequestSchema');
        const ScmBranchIntegrationResponseSchema = readScmSchema('ScmBranchIntegrationResponseSchema');

        expect(ScmBranchIntegrationRequestSchema.parse({
            cwd: '.',
            sourceRef: ' origin/main ',
        })).toMatchObject({
            sourceRef: 'origin/main',
        });
        expect(ScmBranchOperationControlRequestSchema.parse({
            cwd: '.',
            operation: 'rebase',
        })).toMatchObject({
            operation: 'rebase',
        });
        expect(ScmBranchIntegrationResponseSchema.parse({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            operationState: {
                kind: 'rebase',
                sourceRef: 'main',
                canContinue: true,
                canAbort: true,
            },
        })).toMatchObject({
            operationState: {
                kind: 'rebase',
                sourceRef: 'main',
            },
        });

        expect(ScmBranchIntegrationRequestSchema.safeParse({
            cwd: '.',
            sourceRef: '--upload-pack=hack',
        }).success).toBe(false);
        expect(ScmBranchIntegrationRequestSchema.safeParse({
            cwd: '.',
            sourceRef: 'origin/feature branch',
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

    it('rejects root-equivalent selected paths for mutation requests', () => {
        const invalidSelectedPaths = [
            '',
            ' ',
            '.',
            './',
            ':',
            ':(top)*',
            '-path',
            'src/../..',
            '/repo',
            'C:\\repo',
        ];

        for (const path of invalidSelectedPaths) {
            expect(ScmChangeApplyRequestSchema.safeParse({
                cwd: '.',
                paths: [path],
            }).success).toBe(false);
            expect(ScmChangeDiscardRequestSchema.safeParse({
                cwd: '.',
                entries: [{ path, kind: 'modified' }],
            }).success).toBe(false);
            expect(ScmCommitCreateRequestSchema.safeParse({
                cwd: '.',
                message: 'Scoped commit',
                scope: {
                    kind: 'paths',
                    include: [path],
                },
            }).success).toBe(false);
            expect(ScmCommitCreateRequestSchema.safeParse({
                cwd: '.',
                message: 'Scoped commit',
                scope: {
                    kind: 'paths',
                    include: ['src/a.ts'],
                    exclude: [path],
                },
            }).success).toBe(false);
            expect(ScmCommitCreateRequestSchema.safeParse({
                cwd: '.',
                message: 'Patch commit',
                patches: [{
                    path,
                    patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
                }],
            }).success).toBe(false);
        }
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

    describe('ScmWorktreesEnrichmentRequestSchema', () => {
        it('accepts known worktree paths up to the protocol cap', () => {
            const parsed = ScmWorktreesEnrichmentRequestSchema.parse({
                cwd: '/repo',
                worktreePaths: Array.from({ length: SCM_WORKTREES_ENRICHMENT_MAX_PATHS }, (_, index) => `/repo/wt-${index}`),
            });

            expect(parsed.worktreePaths).toHaveLength(SCM_WORKTREES_ENRICHMENT_MAX_PATHS);
        });

        it('rejects requests over the protocol cap', () => {
            const result = ScmWorktreesEnrichmentRequestSchema.safeParse({
                cwd: '/repo',
                worktreePaths: Array.from({ length: SCM_WORKTREES_ENRICHMENT_MAX_PATHS + 1 }, (_, index) => `/repo/wt-${index}`),
            });

            expect(result.success).toBe(false);
        });
    });

    describe('ScmWorktreesEnrichmentResponseSchema', () => {
        it('parses per-worktree enrichment entries', () => {
            const parsed = ScmWorktreesEnrichmentResponseSchema.parse({
                success: true,
                worktrees: [
                    {
                        path: '/repo',
                        changeCount: 3,
                        lastActivityAt: 1710000000000,
                    },
                ],
            });

            expect(parsed.worktrees?.[0]?.changeCount).toBe(3);
            expect(parsed.worktrees?.[0]?.lastActivityAt).toBe(1710000000000);
        });
    });
});
