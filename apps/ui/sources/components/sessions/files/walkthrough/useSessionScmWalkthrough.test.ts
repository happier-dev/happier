import { describe, expect, it } from 'vitest';

import type { ScmDiffSummaryEntry, ScmDiffSummaryState } from '@/sync/domains/scm/diffSummary/state';

import { selectSessionScmWalkthroughKey } from '@/sync/domains/scm/diffSummary/selection';

function entry(key: string, overrides: Partial<ScmDiffSummaryEntry> & Pick<ScmDiffSummaryEntry, 'input'>): ScmDiffSummaryEntry {
    return {
        key,
        sessionId: 's1',
        status: 'running',
        actionId: 'scm.diffSummary.generate',
        executionRunId: null,
        callId: null,
        sidechainId: null,
        pendingIntent: null,
        requestedAtMs: 0,
        observedAtMs: null,
        streamingMarkdown: null,
        latestRun: null,
        finalSummary: null,
        lastKnownSummary: null,
        latestOutput: null,
        error: null,
        retryAttempt: 0,
        ...overrides,
    };
}

function state(entries: readonly ScmDiffSummaryEntry[]): ScmDiffSummaryState {
    return { entriesByKey: Object.fromEntries(entries.map((value) => [value.key, value])) };
}

describe('selectSessionScmWalkthroughKey', () => {
    it('does not read another Account or Home with the same Session id', () => {
        const input = { cwd: '/r', source: { kind: 'workingTree' as const }, outputs: ['walkthrough' as const] };
        const entries = state([
            entry('mine', { scopeKey: 'home:a', input }),
            entry('other', { scopeKey: 'home:b', input, requestedAtMs: 10 }),
            entry('unscoped', { input, requestedAtMs: 20 }),
        ]);
        expect(selectSessionScmWalkthroughKey(entries, 's1', input.source, 'walkthrough', 'home:a')).toBe('mine');
        expect(selectSessionScmWalkthroughKey(entries, 's1', input.source, 'walkthrough', 'missing')).toBeNull();
    });
    it('finds proposals added to an existing result even when the initial request only asked for walkthrough', () => {
        const existing = entry('existing', { requestedAtMs: 5, input: { cwd: '/r', source: { kind: 'workingTree' }, outputs: ['walkthrough'] } });
        const withProposal: ScmDiffSummaryEntry = { ...existing, latestOutput: { success: true, sourceKey: 'pending', metadata: { sourceKey: 'pending', source: { kind: 'workingTree' } }, outputs: { commitPlan: { state: 'complete', value: { groups: [], leftOutChangeRefs: [] } } } } };
        const narrationOnly = entry('newer-narration', { requestedAtMs: 9, input: { cwd: '/r', source: { kind: 'workingTree' }, outputs: ['walkthrough'] } });
        expect(selectSessionScmWalkthroughKey(state([withProposal, narrationOnly]), 's1', { kind: 'workingTree' }, 'commitPlan')).toBe('existing');
    });
    it('picks this Session’s latest walkthrough request for exactly the shown comparison', () => {
        const picked = selectSessionScmWalkthroughKey(state([
            entry('older', { requestedAtMs: 1, input: { cwd: '/r', source: { kind: 'session', sessionId: 's1' }, outputs: ['walkthrough'] } }),
            entry('newer', { requestedAtMs: 5, input: { cwd: '/r', source: { kind: 'session', sessionId: 's1' }, outputs: ['summary', 'walkthrough'] } }),
            entry('summary-only', { requestedAtMs: 9, input: { cwd: '/r', source: { kind: 'session', sessionId: 's1' } } }),
            entry('other-session', { sessionId: 's2', requestedAtMs: 9, input: { cwd: '/r', source: { kind: 'session', sessionId: 's2' }, outputs: ['walkthrough'] } }),
            entry('pending', { requestedAtMs: 9, input: { cwd: '/r', source: { kind: 'workingTree' }, outputs: ['walkthrough'] } }),
        ]), 's1', { kind: 'session' });
        expect(picked).toBe('newer');
    });

    it('matches a turn by its turn, never another turn of the same Session', () => {
        const turns = state([
            entry('turn-a', { input: { cwd: '/r', source: { kind: 'turnCheckpoint', turnId: 'a' }, outputs: ['walkthrough'] } }),
            entry('turn-b', { input: { cwd: '/r', source: { kind: 'turnCheckpoint', turnId: 'b' }, outputs: ['walkthrough'] } }),
        ]);
        expect(selectSessionScmWalkthroughKey(turns, 's1', { kind: 'turnCheckpoint', turnId: 'b' })).toBe('turn-b');
        expect(selectSessionScmWalkthroughKey(turns, 's1', { kind: 'turnCheckpoint', turnId: 'c' })).toBeNull();
        expect(selectSessionScmWalkthroughKey(turns, 's1', null)).toBeNull();
    });
});
