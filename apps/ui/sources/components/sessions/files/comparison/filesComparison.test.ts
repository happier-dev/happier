import { describe, expect, it } from 'vitest';

import {
    describeChangedFilesModeAsComparison,
    listFilesComparisonScopeOptions,
    resolveFilesComparisonPresentation,
    filesComparisonScopeOptionKey,
} from './filesComparison';

const ALL = {
    showTurnViewToggle: true,
    showTurnAgentReportedViewToggle: true,
    showTurnCheckpointViewToggle: true,
    showSessionViewToggle: true,
};
const NONE = {
    showTurnViewToggle: false,
    showTurnAgentReportedViewToggle: false,
    showTurnCheckpointViewToggle: false,
    showSessionViewToggle: false,
};

describe('Files comparison (one owner for what Files shows)', () => {
    it('shows exactly the comparison the link names, with its evidence', () => {
        expect(resolveFilesComparisonPresentation({ kind: 'workingTree' }, ALL)).toEqual({ kind: 'changedFiles', mode: 'repository' });
        expect(resolveFilesComparisonPresentation({ kind: 'session' }, ALL)).toEqual({ kind: 'captured' });
        expect(resolveFilesComparisonPresentation({ kind: 'turnCheckpoint', turnId: 't1' }, ALL)).toEqual({ kind: 'changedFiles', mode: 'turn' });
        expect(resolveFilesComparisonPresentation({ kind: 'turnCheckpoint', turnId: 't1', evidence: 'checkpoint' }, ALL)).toEqual({ kind: 'changedFiles', mode: 'turn_checkpoint' });
        expect(resolveFilesComparisonPresentation({ kind: 'turnCheckpoint', turnId: 't1', evidence: 'agent_reported' }, ALL)).toEqual({ kind: 'changedFiles', mode: 'turn_agent_reported' });
    });

    it('reads hosted and immutable comparisons from the captured evidence owner', () => {
        // A named turn without evidence stays that turn (its empty state says so), never pending changes.
        expect(resolveFilesComparisonPresentation({ kind: 'turnCheckpoint', turnId: 't1' }, NONE)).toEqual({ kind: 'changedFiles', mode: 'turn' });
        expect(resolveFilesComparisonPresentation({ kind: 'branch', head: 'feature', base: 'main' }, ALL)).toEqual({ kind: 'captured' });
        expect(resolveFilesComparisonPresentation({ kind: 'commit', commit: 'abc1234' }, ALL)).toEqual({ kind: 'captured' });
        expect(resolveFilesComparisonPresentation({ kind: 'pullRequest', locator: { providerId: 'github', repository: 'owner/repo', number: 42 } }, NONE)).toEqual({ kind: 'captured' });
        expect(resolveFilesComparisonPresentation({ kind: 'workingTree', comparisonId: 'saved-pending' }, ALL)).toEqual({ kind: 'captured' });
        expect(resolveFilesComparisonPresentation({ kind: 'turnCheckpoint', checkpointReceiptId: 'saved-receipt' }, NONE)).toEqual({ kind: 'captured' });
    });

    it('keeps today’s default for a link without a comparison, and names it as a comparison', () => {
        expect(resolveFilesComparisonPresentation(null, ALL)).toEqual({ kind: 'changedFiles', mode: 'turn' });
        expect(resolveFilesComparisonPresentation(null, NONE)).toEqual({ kind: 'changedFiles', mode: 'repository' });
        expect(describeChangedFilesModeAsComparison('turn', 'turn-7')).toEqual({ kind: 'turnCheckpoint', turnId: 'turn-7' });
        expect(describeChangedFilesModeAsComparison('turn', null)).toBeNull();
        expect(describeChangedFilesModeAsComparison('repository', null)).toEqual({ kind: 'workingTree' });
    });

    it('offers all six source kinds from pending and historical views, grouped by consequence', () => {
        const options = listFilesComparisonScopeOptions(ALL, 'turn-7');
        expect(options.map((option) => [option.group, filesComparisonScopeOptionKey(option)])).toEqual([
            ['explainAndCommit', 'workingTree'],
            ['explainOnly', 'session'],
            ['explainOnly', 'turnCheckpoint:turn-7'],
            ['explainOnly', 'turnCheckpoint:turn-7:agent_reported'],
            ['explainOnly', 'turnCheckpoint:turn-7:checkpoint'],
            ['explainOnly', 'branch'],
            ['explainOnly', 'commit'],
            ['explainOnly', 'pullRequest'],
        ]);
        for (const current of [{ kind: 'workingTree' }, { kind: 'commit', commit: 'abc' }] as const) {
            const scopes = listFilesComparisonScopeOptions(NONE, null, current);
            expect(new Set(scopes.map((option) => option.comparison?.kind ?? option.sourceKind)))
                .toEqual(new Set(['workingTree', 'session', 'turnCheckpoint', 'branch', 'commit', 'pullRequest']));
        }
    });
    it('explains each scope consequence, with observed counts instead of guessing unavailable totals', () => {
        const options = listFilesComparisonScopeOptions(ALL, 'turn-7', null, {
            pendingFileCount: 9, sessionFileCount: 6, latestTurnFileCount: 2,
        });
        expect(options[0]?.subtitle).toContain('9');
        expect(options[0]?.subtitle).toContain('commits');
        expect(options[1]?.subtitle).toContain('start → now');
        expect(options[1]?.subtitle).toContain('6');
        expect(options[2]?.subtitle).toContain('2');
        expect(options.slice(1).every((option) => !option.subtitle.includes('commits'))).toBe(true);
        expect(listFilesComparisonScopeOptions(NONE, null)[0]?.subtitle).not.toMatch(/\d/);
    });
});
