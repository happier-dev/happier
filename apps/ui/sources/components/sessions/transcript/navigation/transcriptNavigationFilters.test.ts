import { describe, expect, it } from 'vitest';

import {
    filterTranscriptNavigationEntries,
    isTranscriptNavigationFilterPartial,
    resolveTranscriptNavigationFilterChips,
    summarizeTranscriptNavigationEntries,
} from './transcriptNavigationFilters';
import type { TranscriptNavigationEntry, TranscriptNavigationTurnFacts } from './transcriptNavigationTypes';

function facts(overrides: Partial<TranscriptNavigationTurnFacts> = {}): TranscriptNavigationTurnFacts {
    return { toolCount: 1, failedCount: 0, approvals: [], running: false, lastToolFailed: false, endedAtMs: null, ...overrides };
}

function entry(id: string, overrides: Partial<TranscriptNavigationEntry> = {}): TranscriptNavigationEntry {
    return {
        id,
        sessionId: 's1',
        seq: 1,
        routeMessageId: null,
        transcriptBlockIndex: null,
        kind: 'user-turn',
        role: 'user',
        label: id,
        promptPreview: id,
        responsePreview: null,
        createdAtMs: null,
        pinned: false,
        pinnedAtMs: null,
        loaded: true,
        facts: facts(),
        ...overrides,
    };
}

const ENTRIES: readonly TranscriptNavigationEntry[] = [
    entry('plain'),
    entry('asked', { facts: facts({ approvals: [{ outcome: 'allowed', label: 'yarn test' }] }) }),
    entry('failed', { pinned: true, facts: facts({ failedCount: 2 }) }),
    entry('waiting', { facts: facts({ approvals: [{ outcome: 'pending', label: 'git push' }], running: true }) }),
    entry('pinned-answer', { kind: 'pinned-assistant', role: 'assistant', pinned: true, facts: null }),
];

describe('transcript navigation filters', () => {
    it('counts turns (not pinned answers), pins, approvals, errors and what waits for you', () => {
        expect(summarizeTranscriptNavigationEntries(ENTRIES)).toEqual({
            counts: { all: 4, pinned: 2, approvals: 2, questions: 0, errors: 1 },
            waitingCount: 1,
            approvalWaitingCount: 1,
            questionWaitingCount: 0,
        });
    });

    it('keeps only the turns each filter hunts for', () => {
        const ids = (filter: Parameters<typeof filterTranscriptNavigationEntries>[1]) => (
            filterTranscriptNavigationEntries(ENTRIES, filter).map((item) => item.id)
        );
        expect(ids('all')).toEqual(['plain', 'asked', 'failed', 'waiting', 'pinned-answer']);
        expect(ids('pinned')).toEqual(['failed', 'pinned-answer']);
        expect(ids('approvals')).toEqual(['asked', 'waiting']);
        expect(ids('errors')).toEqual(['failed']);
    });

    it('finds question turns independently of approvals and includes pending questions in Waiting', () => {
        const entries = [...ENTRIES,
            entry('question', { facts: facts({ questionCount: 1 }) }),
            entry('pending-question', { facts: facts({ questionCount: 2, hasPendingQuestion: true }) }),
        ];
        const summary = summarizeTranscriptNavigationEntries(entries);
        expect(summary.counts.questions).toBe(2);
        expect(summary.counts.approvals).toBe(2);
        expect(summary.waitingCount).toBe(2);
        expect(resolveTranscriptNavigationFilterChips(summary, 'all')).toContain('questions');
        expect(filterTranscriptNavigationEntries(entries, 'questions').map((item) => item.id))
            .toEqual(['question', 'pending-question']);
    });

    it('offers Approvals and Errors only when they have something, unless one is the current filter', () => {
        const summary = summarizeTranscriptNavigationEntries([entry('plain')]);
        expect(resolveTranscriptNavigationFilterChips(summary, 'all')).toEqual(['all', 'pinned']);
        expect(resolveTranscriptNavigationFilterChips(summary, 'errors')).toEqual(['all', 'pinned', 'errors']);
        expect(resolveTranscriptNavigationFilterChips(summarizeTranscriptNavigationEntries(ENTRIES), 'all'))
            .toEqual(['all', 'pinned', 'approvals', 'errors']);
    });

    it('calls a fact filter partial while any turn is unknown or earlier history is not loaded', () => {
        const unknownTurn = [...ENTRIES, entry('remote', { loaded: false, facts: null })];
        expect(isTranscriptNavigationFilterPartial({ entries: ENTRIES, filter: 'approvals', historyComplete: true })).toBe(false);
        expect(isTranscriptNavigationFilterPartial({ entries: unknownTurn, filter: 'approvals', historyComplete: true })).toBe(true);
        expect(isTranscriptNavigationFilterPartial({ entries: ENTRIES, filter: 'errors', historyComplete: false })).toBe(true);
        // All and Pinned are not about facts: they are never partial for that reason.
        expect(isTranscriptNavigationFilterPartial({ entries: unknownTurn, filter: 'pinned', historyComplete: false })).toBe(false);
    });
});
