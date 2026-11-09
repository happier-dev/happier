import { describe, expect, it } from 'vitest';

import {
    SessionPullRequestLinkCompletionInputV1Schema,
    SessionPullRequestLinkCompletionResultV1Schema,
} from './index.js';

describe('explicit Session PR link completion protocol', () => {
    it('admits only an exact Session address without caller-authored authority', () => {
        const input = { v: 1, session: { serverId: 'home-1', sessionId: 'session-1' } };
        expect(SessionPullRequestLinkCompletionInputV1Schema.parse(input)).toEqual(input);
        for (const invalid of [
            { ...input, trusted: true },
            { ...input, session: { ...input.session, accountId: 'forged' } },
            { ...input, session: { serverId: 'home-1', sessionId: { selector: 'all' } } },
        ]) expect(SessionPullRequestLinkCompletionInputV1Schema.safeParse(invalid).success).toBe(false);
    });

    it('reports only placement outcomes, never another link or replay instruction', () => {
        for (const kind of ['added', 'present', 'unavailable']) {
            expect(SessionPullRequestLinkCompletionResultV1Schema.parse({ kind })).toEqual({ kind });
        }
        expect(SessionPullRequestLinkCompletionResultV1Schema.safeParse({ kind: 'retry' }).success).toBe(false);
        expect(SessionPullRequestLinkCompletionResultV1Schema.safeParse({ kind: 'added', retry: true }).success).toBe(false);
    });
});
