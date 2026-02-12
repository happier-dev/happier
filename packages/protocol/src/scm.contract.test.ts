import { describe, expect, it } from 'vitest';

import {
    SCM_COMMIT_PATCH_MAX_COUNT,
    SCM_COMMIT_PATCH_MAX_LENGTH,
    SCM_OPERATION_ERROR_CODES,
    ScmBackendDescribeResponseSchema,
    ScmCommitCreateRequestSchema,
    isScmPatchBoundToPath,
    parseScmPatchPaths,
    ScmStatusSnapshotRequestSchema,
    ScmStatusSnapshotResponseSchema,
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
                workspaceWorktreeCreate: false,
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
                workspaceWorktreeCreate: true,
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

        const response = ScmStatusSnapshotResponseSchema.parse({
            success: true,
            snapshot,
        });

        expect(response.snapshot?.repo.backendId).toBe('git');
        expect(response.snapshot?.totals.pendingFiles).toBe(0);
        expect(response.snapshot?.capabilities.changeSetModel).toBe('index');
        expect(response.snapshot?.capabilities.supportedDiffAreas).toEqual(['included', 'pending', 'both']);
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
