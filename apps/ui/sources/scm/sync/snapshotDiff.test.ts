import { describe, expect, it } from 'vitest';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { areScmWorkingSnapshotsEquivalentIgnoringFetchedAt } from './snapshotDiff';

describe('SCM snapshot page publication', () => {
    const base = ScmWorkingSnapshotSchema.parse({
        projectKey: 'paged-diff', fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: createScmCapabilities({ readStatus: true }),
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 54_935, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    });

    it('publishes changes in page total or completion while unchanged page metadata stays quiet', () => {
        const page: ScmWorkingSnapshot = { ...base, entriesPage: { totalFiles: 54_935, nextCursor: 20 } };
        expect(areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(page, { ...page, fetchedAt: 2 })).toBe(true);
        expect(areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(page,
            { ...page, entriesPage: { totalFiles: 54_935, nextCursor: null } })).toBe(false);
        expect(areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(page,
            { ...page, entriesPage: { totalFiles: 54_936, nextCursor: 20 } })).toBe(false);
        expect(areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(page, base)).toBe(false);
    });

    it('compares only delivered rows even when the working copy contains 54,935 files', () => {
        let visits = 0;
        const entries: ScmWorkingSnapshot['entries'] = Array.from({ length: 20 }, (_, index) => ({
            path: `file-${index}.ts`, previousPath: null,
            get kind() { visits++; return 'modified' as const; },
            includeStatus: '', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        }));
        const page: ScmWorkingSnapshot = { ...base, entries, entriesPage: { totalFiles: 54_935, nextCursor: 20 } };
        expect(areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(page, { ...page, fetchedAt: 2 })).toBe(true);
        expect(visits).toBeLessThanOrEqual(entries.length * 2);
        const changed = { ...page, entries: [...entries.slice(0, -1), { ...entries.at(-1)!, pendingStatus: 'A' }] };
        expect(areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(page, changed)).toBe(false);
    });
});
