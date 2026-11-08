import { describe, expect, it } from 'vitest';
import { createScmCapabilities, summarizeScmChanges, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import * as demand from './scmEntriesDemand';

describe('SCM entries delivery demand', () => {
    it('admits only effective demand changes, with full consumers overriding the largest viewport', () => {
        const slot = { kind: 'session' as const, sessionId: 'paged-demand-test' };
        const admitted: Array<number | undefined> = [];
        const stop = demand.subscribeScmEntriesDemandAdmissions(current => {
            if (demand.isSameScmEntriesDemandSlot(current, slot)) admitted.push(demand.readScmEntriesPageSize(slot));
        });
        const releases: Array<() => void> = [];
        try {
            expect(demand.hasScmEntriesDemand(slot)).toBe(false);
            releases.push(demand.retainScmEntriesDemand(slot, 20));
            releases.push(demand.retainScmEntriesDemand(slot, 10));
            releases.push(demand.retainScmEntriesDemand(slot, 40));
            releases.push(demand.retainScmEntriesDemand(slot));
            releases.push(demand.retainScmEntriesDemand(slot, 60));
            releases.push(demand.retainScmEntriesDemand(slot));
            expect(demand.readScmEntriesPageSize(slot)).toBeUndefined();
            releases[3]!();
            expect(demand.readScmEntriesPageSize(slot)).toBeUndefined();
            releases[5]!();
            expect(demand.readScmEntriesPageSize(slot)).toBe(60);
            releases[4]!();
            expect(demand.readScmEntriesPageSize(slot)).toBe(40);
            releases[2]!();
            expect(demand.readScmEntriesPageSize(slot)).toBe(20);
            expect(admitted).toEqual([20, 40, undefined, 60, 40, 20]);
        } finally {
            for (const release of releases) release();
            stop();
        }
        expect(demand.hasScmEntriesDemand(slot)).toBe(false);
        expect(demand.readScmEntriesPageSize(slot)).toBeUndefined();
    });

    it('retains the producer full summary without walking page rows or retaining page metadata', () => {
        const base = ScmWorkingSnapshotSchema.parse({
            projectKey: 'paged-counts', fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
            capabilities: createScmCapabilities({ readStatus: true }),
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false, entries: [],
            totals: { includedFiles: 0, pendingFiles: 54_935, untrackedFiles: 0,
                includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        });
        const summary = { ...summarizeScmChanges(base.entries, base.totals), changedFiles: 54_935 };
        const page: ScmWorkingSnapshot = { ...base, summary, entriesPage: { totalFiles: 54_935, nextCursor: 20 } };
        Object.defineProperty(page.entries, Symbol.iterator, { value: () => { throw new Error('counts must use producer summary'); } });
        const counts = demand.readScmSnapshotCounts(page);
        expect(counts.summary).toBe(summary);
        expect(counts.entries).toEqual([]);
        expect(counts).not.toHaveProperty('entriesPage');
        expect(demand.readScmSnapshotCounts(page)).toBe(counts);
    });
});
