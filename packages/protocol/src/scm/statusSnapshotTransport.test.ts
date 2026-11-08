import { describe, expect, it } from 'vitest';

import { createScmCapabilities } from './capabilities.js';
import { ScmStatusSnapshotRequestSchema, ScmStatusSnapshotResponseSchema } from './index.js';
import { ScmWorkingEntrySchema, ScmWorkingSnapshotSchema } from './workingSnapshot.js';

describe('SCM status snapshot transport', () => {
    it('accepts demand-sized page requests and rejects invalid paging operands', () => {
        const entriesPage = { limit: 5, cursor: 10 };
        expect(ScmStatusSnapshotRequestSchema.parse({ entriesPage })).toEqual({ entriesPage });
        expect(ScmStatusSnapshotRequestSchema.parse({ entriesPage: { limit: 1, path: 'selected.txt' } })).toEqual({ entriesPage: { limit: 1, path: 'selected.txt' } });
        for (const invalid of [{ limit: 0 }, { limit: 1.5 }, { limit: 5, cursor: -1 }, { limit: 5, cursor: 0.5 }, { limit: 5, path: '' }, { limit: 5, authority: true }]) {
            expect(ScmStatusSnapshotRequestSchema.safeParse({ entriesPage: invalid }).success).toBe(false);
        }
    });
    it('restores omitted zero statistics, false deltas and absent rename origins without losing measured facts', () => {
        const input = {
            success: true,
            snapshot: {
                projectKey: 'machine:/repo', fetchedAt: 1,
                repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                capabilities: createScmCapabilities(),
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                hasConflicts: false,
                entries: [
                    { path: 'new.txt', kind: 'untracked', includeStatus: '?', pendingStatus: '?', hasPendingDelta: true, stats: { pendingAdded: 7 } },
                    { path: 'binary.bin', kind: 'modified', includeStatus: '.', pendingStatus: 'M', hasPendingDelta: true, stats: { isBinary: true, isComplete: false } },
                    { path: 'renamed.txt', previousPath: 'old.txt', kind: 'renamed', includeStatus: 'R', pendingStatus: '.', hasIncludedDelta: true },
                    { path: 'both.txt', kind: 'modified', includeStatus: 'M', pendingStatus: 'M', hasIncludedDelta: true, hasPendingDelta: true, stats: { includedAdded: 3, includedRemoved: 4, pendingAdded: 5, pendingRemoved: 6, isComplete: true } },
                ],
                totals: { includedFiles: 1, pendingFiles: 2, untrackedFiles: 1, includedAdded: 0, includedRemoved: 0, pendingAdded: 7, pendingRemoved: 0, isComplete: false },
            },
        };
        const response = ScmStatusSnapshotResponseSchema.parse(input);
        expect(ScmWorkingSnapshotSchema.parse(input.snapshot)).toEqual(response.snapshot);
        expect(response.snapshot?.entries).toEqual([
            { path: 'new.txt', previousPath: null, kind: 'untracked', includeStatus: '?', pendingStatus: '?', hasIncludedDelta: false, hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 7, pendingRemoved: 0, isBinary: false } },
            { path: 'binary.bin', previousPath: null, kind: 'modified', includeStatus: '.', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: true, isComplete: false } },
            { path: 'renamed.txt', previousPath: 'old.txt', kind: 'renamed', includeStatus: 'R', pendingStatus: '.', hasIncludedDelta: true, hasPendingDelta: false, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false } },
            { path: 'both.txt', previousPath: null, kind: 'modified', includeStatus: 'M', pendingStatus: 'M', hasIncludedDelta: true, hasPendingDelta: true, stats: { includedAdded: 3, includedRemoved: 4, pendingAdded: 5, pendingRemoved: 6, isBinary: false, isComplete: true } },
        ]);
        expect(response.snapshot?.totals.isComplete).toBe(false);
        for (const entry of response.snapshot?.entries ?? []) expect(ScmWorkingEntrySchema.safeParse(entry).success).toBe(true);
        expect(ScmStatusSnapshotResponseSchema.parse(JSON.parse(JSON.stringify(response)))).toEqual(response);
        expect(ScmStatusSnapshotResponseSchema.safeParse({ ...input, snapshot: { ...input.snapshot, entries: [{ ...input.snapshot.entries[0], stats: { pendingAdded: -1 } }] } }).success).toBe(false);
    });
});
