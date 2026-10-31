import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RPC_METHODS } from './rpc.js';
import {
    SCM_STATUS_ENTRIES_MAX_PAGE,
    SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES,
    ScmRequestBaseSchema,
    ScmStatusEntriesRequestSchema,
    ScmStatusEntriesResponseSchema,
    ScmStatusSnapshotRequestSchema,
    ScmWorkingSnapshotSchema,
} from './scm.js';

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

describe('SCM snapshot cardinality and split delivery contract', () => {
    // Frozen pre-change request schema: exactly what the released (old) daemon
    // parses — ScmRequestBaseSchema + includeWorktreeStatus, nothing else. The
    // request-strip compat pin below parses the NEW-shape request against this
    // fixture, NOT the live schema, so a later live-schema edit cannot
    // silently satisfy the pin.
    const FrozenPreChangeScmStatusSnapshotRequestSchema = ScmRequestBaseSchema.extend({
        includeWorktreeStatus: z.boolean().optional(),
    });

    const preChangeCapabilities = {
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
        supportedDiffAreas: ['included'],
    };
    const preChangeEntry = {
        path: 'a.txt',
        previousPath: null,
        kind: 'untracked',
        includeStatus: '?',
        pendingStatus: '?',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
            isBinary: false,
        },
    };
    const preChangeSnapshot = {
        projectKey: 'k:/repo',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [],
            remotes: [],
        },
        capabilities: preChangeCapabilities,
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
        },
        hasConflicts: false,
        entries: [preChangeEntry],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 1,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
    };

    it('pins the shared serialized-entry byte budget and the entries page cap', () => {
        expect(SCM_STATUS_SNAPSHOT_MAX_ENTRY_BYTES).toBe(4_194_304);
        expect(SCM_STATUS_ENTRIES_MAX_PAGE).toBe(500);
    });

    it('defines the paged entries method constant', () => {
        expect(RPC_METHODS.SCM_STATUS_ENTRIES).toBe('scm.status.entries');
    });

    it('parses a pre-change snapshot payload unchanged under the extended schemas', () => {
        const parsed = ScmWorkingSnapshotSchema.safeParse(preChangeSnapshot);
        expect(parsed.success).toBe(true);
    });

    it('parses a new-shape snapshot carrying entriesPresentation, collapsed directory entries, and totals.changedFiles', () => {
        const newShapeSnapshot = {
            ...preChangeSnapshot,
            entriesPresentation: 'truncated',
            entries: [
                {
                    ...preChangeEntry,
                    path: 'D/',
                    isDirectory: true,
                    untrackedFileCount: 3,
                    stats: {
                        includedAdded: 0,
                        includedRemoved: 0,
                        pendingAdded: 0,
                        pendingRemoved: 0,
                        isBinary: false,
                        isComplete: false,
                    },
                },
            ],
            totals: {
                ...preChangeSnapshot.totals,
                changedFiles: 3,
            },
        };
        const parsed = ScmWorkingSnapshotSchema.safeParse(newShapeSnapshot);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.entriesPresentation).toBe('truncated');
            expect(parsed.data.entries[0]?.isDirectory).toBe(true);
            expect(parsed.data.entries[0]?.untrackedFileCount).toBe(3);
            expect(parsed.data.totals.changedFiles).toBe(3);
        }
    });

    it('accepts the new snapshot request fields under the live request schema', () => {
        const parsed = ScmStatusSnapshotRequestSchema.safeParse({
            cwd: '/repo',
            untrackedFiles: 'normal',
            includeEntries: false,
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.untrackedFiles).toBe('normal');
            expect(parsed.data.includeEntries).toBe(false);
        }
    });

    it('strips new-shape request fields under the frozen pre-change schema (old-daemon compat pin)', () => {
        const parsed = FrozenPreChangeScmStatusSnapshotRequestSchema.parse({
            cwd: '/repo',
            untrackedFiles: 'normal',
            includeEntries: false,
        });
        expect(parsed).toEqual({ cwd: '/repo' });
        expect(Object.keys(parsed)).toEqual(['cwd']);
    });

    it('parses the paged entries request and response shapes', () => {
        expect(ScmStatusEntriesRequestSchema.safeParse({ cwd: '/repo' }).success).toBe(true);
        expect(ScmStatusEntriesRequestSchema.safeParse({
            cwd: '/repo',
            afterPath: 'a.txt',
            limit: 50,
            area: 'pending',
            expandPath: 'D',
        }).success).toBe(true);
        expect(ScmStatusEntriesRequestSchema.safeParse({ cwd: '/repo', limit: 0 }).success).toBe(false);
        expect(ScmStatusEntriesRequestSchema.safeParse({ cwd: '/repo', limit: SCM_STATUS_ENTRIES_MAX_PAGE + 1 }).success).toBe(false);
        expect(ScmStatusEntriesRequestSchema.safeParse({ cwd: '/repo', area: 'both' }).success).toBe(false);

        expect(ScmStatusEntriesResponseSchema.safeParse({
            success: true,
            entries: [preChangeEntry],
            hasMore: true,
            nextCursor: 'a.txt',
            fetchedAt: 1,
        }).success).toBe(true);
        expect(ScmStatusEntriesResponseSchema.safeParse({ success: true, entries: [], hasMore: false, fetchedAt: 1 }).success).toBe(true);
        expect(ScmStatusEntriesResponseSchema.safeParse({ success: false, entries: [], hasMore: false, fetchedAt: 1, error: 'x', errorCode: 'COMMAND_FAILED' }).success).toBe(true);
    });
});
