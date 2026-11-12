import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { scmUiBackendRegistry } from './scmUiBackendRegistry';

function makeSnapshot(overrides?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [
            {
                path: 'a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: 'M',
                pendingStatus: 'M',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
            },
        ],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
        ...overrides,
    };
}

describe('SCM UI backend statusSummaryMapper changedFiles derivation', () => {
    it('prefers totals.changedFiles over entries.length in every backend plugin (git, sapling, fallback)', () => {
        const snapshot = makeSnapshot({
            entries: [],
            entriesPresentation: 'omitted',
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 30000,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                changedFiles: 30000,
            },
        });

        for (const backendId of ['git', 'sapling', null]) {
            const plugin = scmUiBackendRegistry.getPlugin(backendId);
            const summary = plugin.statusSummaryMapper(snapshot);
            expect(summary?.changedFiles).toBe(30000);
        }
    });

    it('falls back to entries.length when the snapshot carries no server-derived changedFiles', () => {
        const snapshot = makeSnapshot();

        for (const backendId of ['git', 'sapling', null]) {
            const plugin = scmUiBackendRegistry.getPlugin(backendId);
            const summary = plugin.statusSummaryMapper(snapshot);
            expect(summary?.changedFiles).toBe(1);
        }
    });
});
