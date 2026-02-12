import { describe, expect, it } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { evaluateScmOperationPreflight } from './operationPolicy';

function makeSnapshot(
    overrides?: Partial<ScmWorkingSnapshot>,
    totals?: Partial<ScmWorkingSnapshot['totals']>
): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
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
            operationLabels: { commit: 'Commit staged' },
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
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
            ...totals,
        },
        ...overrides,
    };
}

describe('evaluateScmOperationPreflight', () => {
    it('blocks write operations when experimental write flag is disabled', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled: false,
            sessionPath: '/repo',
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('write_disabled');
        }
    });

    it('blocks fetch when experimental write flag is disabled', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'fetch',
            scmWriteEnabled: false,
            sessionPath: '/repo',
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('write_disabled');
        }
    });

    it('blocks operations when session path is missing', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled: true,
            sessionPath: null,
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('missing_session_path');
        }
    });

    it('blocks operations when repository snapshot is not a source control repository', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'stage',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                repo: {
                    isRepo: false,
                    rootPath: null,
                    backendId: null,
                    mode: null,
                },
            }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('not_repository');
        }
    });

    it('blocks operations when capabilities metadata is unavailable', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: {
                ...makeSnapshot(),
                capabilities: undefined as unknown as ScmWorkingSnapshot['capabilities'],
            },
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('feature_unsupported');
        }
    });

    it('allows stage when conflicts are present', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'stage',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({ hasConflicts: true }),
        });

        expect(result.allowed).toBe(true);
    });

    it('requires included files before creating a commit', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('included_changes_required');
        }
    });

    it('blocks pull while worktree is dirty', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'pull',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(undefined, { pendingFiles: 1 }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('clean_worktree_required');
        }
    });

    it('requires upstream for push and pull', () => {
        const pushResult = evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            }),
        });
        const pullResult = evaluateScmOperationPreflight({
            intent: 'pull',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            }),
        });

        expect(pushResult.allowed).toBe(false);
        expect(pullResult.allowed).toBe(false);
        if (!pushResult.allowed) {
            expect(pushResult.reason).toBe('upstream_required');
        }
        if (!pullResult.allowed) {
            expect(pullResult.reason).toBe('upstream_required');
        }
    });

    it('blocks push and pull in detached HEAD state', () => {
        const detachedSnapshot = makeSnapshot({
            branch: { head: null, upstream: 'origin/main', ahead: 0, behind: 0, detached: true },
        });

        const pushResult = evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: detachedSnapshot,
        });
        const pullResult = evaluateScmOperationPreflight({
            intent: 'pull',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: detachedSnapshot,
        });

        expect(pushResult.allowed).toBe(false);
        expect(pullResult.allowed).toBe(false);
        if (!pushResult.allowed) {
            expect(pushResult.reason).toBe('detached_head');
        }
        if (!pullResult.allowed) {
            expect(pullResult.reason).toBe('detached_head');
        }
    });

    it('blocks push when local branch is behind upstream', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 2, detached: false },
            }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('branch_behind_remote');
        }
    });

    it('blocks revert when worktree is not clean', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'revert',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(undefined, { includedFiles: 1 }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('clean_worktree_required');
        }
    });

    it('blocks revert in detached HEAD state', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'revert',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                branch: { head: null, upstream: 'origin/main', ahead: 0, behind: 0, detached: true },
            }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('detached_head');
        }
    });

    it('allows sapling-style commits when pending changes exist without included changes', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(
                {
                    repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl' },
                    capabilities: {
                        ...makeSnapshot().capabilities!,
                        writeInclude: false,
                        writeExclude: false,
                        operationLabels: { commit: 'Commit changes' },
                    },
                },
                { pendingFiles: 1 },
            ),
        });

        expect(result.allowed).toBe(true);
    });

    it('allows git commit preflight in atomic strategy when pending changes exist', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(undefined, { pendingFiles: 1 }),
            commitStrategy: 'atomic',
        } as any);

        expect(result.allowed).toBe(true);
    });

    it('blocks atomic commit when selected paths have no pending changes', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(undefined, { pendingFiles: 1 }),
            commitStrategy: 'atomic',
            commitSelectionPaths: ['missing.ts'],
        } as any);

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('included_changes_required');
        }
    });

    it('allows atomic commit when selected scope path matches pending nested file paths', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'commit',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                entries: [{
                    path: 'src/a.ts',
                    previousPath: null,
                    kind: 'modified',
                    includeStatus: '.',
                    pendingStatus: 'M',
                    hasIncludedDelta: false,
                    hasPendingDelta: true,
                    stats: {
                        includedAdded: 0,
                        includedRemoved: 0,
                        pendingAdded: 1,
                        pendingRemoved: 0,
                        isBinary: false,
                    },
                }],
            }, { pendingFiles: 1 }),
            commitStrategy: 'atomic',
            commitSelectionPaths: ['src'],
        } as any);

        expect(result.allowed).toBe(true);
    });

    it('blocks stage/unstage intents when backend does not support include/exclude', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'stage',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot({
                repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl' },
                capabilities: {
                    ...makeSnapshot().capabilities!,
                    writeInclude: false,
                    writeExclude: false,
                },
            }),
        });

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('feature_unsupported');
        }
    });

    it('blocks stage when commit strategy is atomic', () => {
        const result = evaluateScmOperationPreflight({
            intent: 'stage',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot: makeSnapshot(undefined, { pendingFiles: 1 }),
            commitStrategy: 'atomic',
        } as any);

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('feature_unsupported');
        }
    });

    it('blocks sapling pull/push preflight when upstream target is missing even if head exists', () => {
        const snapshot = makeSnapshot({
            repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl' },
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            capabilities: {
                ...makeSnapshot().capabilities!,
                writeInclude: false,
                writeExclude: false,
            },
        });

        const pushResult = evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot,
        });
        const pullResult = evaluateScmOperationPreflight({
            intent: 'pull',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot,
        });

        expect(pushResult.allowed).toBe(false);
        expect(pullResult.allowed).toBe(false);
        if (!pushResult.allowed) {
            expect(pushResult.reason).toBe('upstream_required');
        }
        if (!pullResult.allowed) {
            expect(pullResult.reason).toBe('upstream_required');
        }
    });

    it('still blocks sapling pull/push preflight when no active head and no upstream target exist', () => {
        const snapshot = makeSnapshot({
            repo: { isRepo: true, rootPath: '/repo', backendId: 'sapling', mode: '.sl' },
            branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
            capabilities: {
                ...makeSnapshot().capabilities!,
                writeInclude: false,
                writeExclude: false,
            },
        });

        const pushResult = evaluateScmOperationPreflight({
            intent: 'push',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot,
        });
        const pullResult = evaluateScmOperationPreflight({
            intent: 'pull',
            scmWriteEnabled: true,
            sessionPath: '/repo',
            snapshot,
        });

        expect(pushResult.allowed).toBe(false);
        expect(pullResult.allowed).toBe(false);
        if (!pushResult.allowed) {
            expect(pushResult.reason).toBe('upstream_required');
        }
        if (!pullResult.allowed) {
            expect(pullResult.reason).toBe('upstream_required');
        }
    });
});
