import { describe, expect, it } from 'vitest';

import { resolveSessionSectionArchiveOutcome } from './sessionSectionArchiveOutcome';

describe('resolveSessionSectionArchiveOutcome (P5 §7 Archive all)', () => {
    it('stays quiet when every member archived: the rows leaving the section are the result', () => {
        expect(resolveSessionSectionArchiveOutcome({ archivedSessionIds: ['a', 'b'], failures: [], unknownSessionIds: [] })).toBeNull();
    });

    it('stays quiet for an empty section', () => {
        expect(resolveSessionSectionArchiveOutcome({ archivedSessionIds: [], failures: [], unknownSessionIds: [] })).toBeNull();
    });

    it('counts failed and unconfirmed members against the exact total, without replaying successes', () => {
        expect(resolveSessionSectionArchiveOutcome({
            archivedSessionIds: ['a', 'b', 'c'],
            failures: [{ sessionId: 'd', code: 'approval_pending' }],
            unknownSessionIds: ['e'],
        })).toEqual({ archived: 3, total: 5 });
    });

    it('reports a result it cannot read as unknown rather than success', () => {
        expect(resolveSessionSectionArchiveOutcome({ ok: true })).toEqual({ archived: 0, total: null });
    });

    it.each(['session_active', 'session_stop_unconfirmed', 'session_stop_failed', 'session_stop_requested'])(
        'directs unresolved active members to Stop instead of repeating Archive all (%s)', code => {
        expect(resolveSessionSectionArchiveOutcome({
            archivedSessionIds: ['archived'], failures: [{ sessionId: 'active', code }], unknownSessionIds: [],
        })).toEqual({ archived: 1, total: 2, recovery: 'stop_sessions' });
    });
});
