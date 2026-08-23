import { describe, expect, it } from 'vitest';

import issueActivityPage from '../../api/__fixtures__/issueActivityPage.json' with { type: 'json' };
import { createPosthogApiClient, type PosthogTransportRequest } from '../../api/client.js';
import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../../connect/origin.js';
import { POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT } from '../../ui/detail/activityProjection.js';
import { readPosthogIssueActivity } from './issueActivity.js';

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error('fixture origin must normalize');
    return resolved.origin;
}

const ORIGIN = requireOrigin('https://eu.posthog.com');
const ISSUE_ID = '00000000-0000-4000-8000-000000000001';
const ACTIVITY_URL
    = 'https://eu.posthog.com/api/projects/4821/error_tracking/issues/'
    + '00000000-0000-4000-8000-000000000001/activity/';

type Recorded = Readonly<{ url: string; method: string }>;

function setup(respond: (call: number) => Response) {
    const calls: Recorded[] = [];
    const client = createPosthogApiClient({
        origin: ORIGIN,
        now: () => Date.UTC(2026, 7, 14, 12, 0, 0),
        materializeHeaders: async () => ({ ok: true, authorization: 'Bearer test-personal-api-key' }),
        transport: async (url: string, request: PosthogTransportRequest) => {
            calls.push({ url, method: request.method });
            return respond(calls.length);
        },
    });
    return { client, calls };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('readPosthogIssueActivity', () => {
    it('reads one explicit page of the item-scoped activity route', async () => {
        const { client, calls } = setup(() => json(issueActivityPage));

        const outcome = await readPosthogIssueActivity(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            limit: 50,
            page: 1,
        }, {});

        expect(calls).toEqual([{ url: `${ACTIVITY_URL}?limit=50&page=1`, method: 'GET' }]);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.value.records).toHaveLength(2);
        expect(outcome.value.omittedRowCount).toBe(1);
        expect(outcome.value.totalCount).toBe(7);
        // The provider's own `next` advertises page 2; that is the validated position
        // the caller may ask for.
        expect(outcome.value.walk).toEqual({ kind: 'continues', position: 2 });
    });

    it('ends the page walk when the provider states no next page', async () => {
        const { client } = setup(() => json({ ...issueActivityPage, next: null }));

        const outcome = await readPosthogIssueActivity(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            limit: 50,
            page: 1,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // The provider stated no next at all. That, and only that, is exhaustion.
        expect(outcome.value.walk).toEqual({ kind: 'exhausted' });
    });

    it('refuses a next that does not strictly advance this exact route, and says the walk stopped short', async () => {
        const nonAdvancing = `${ACTIVITY_URL}?limit=50&page=1`;
        const elsewhere
            = 'https://eu.posthog.com/api/projects/4821/error_tracking/issues/'
            + '00000000-0000-4000-8000-0000000000ff/activity/?limit=50&page=2';

        for (const next of [nonAdvancing, elsewhere, 'not-a-url', '']) {
            const { client } = setup(() => json({ ...issueActivityPage, next }));
            const outcome = await readPosthogIssueActivity(client, {
                teamRouteId: 4821,
                issueId: ISSUE_ID,
                limit: 50,
                page: 1,
            }, {});

            expect(outcome.ok).toBe(true);
            if (!outcome.ok) return;
            // A next this source cannot verify is not a position: the walk stops rather
            // than reading an unknown page under this issue's name. But the provider
            // DID advertise another page, so stopping is not exhaustion — reporting it
            // as the end of the walk tells a reader they have seen everything PostHog
            // recorded when they have not.
            expect(outcome.value.walk).toEqual({ kind: 'stoppedShort' });
        }
    });

    it('rejects a request it cannot address before any credential is materialized', async () => {
        const { client, calls } = setup(() => json(issueActivityPage));

        for (const input of [
            { teamRouteId: 0, issueId: ISSUE_ID, limit: 50, page: 1 },
            { teamRouteId: 4821, issueId: ISSUE_ID, limit: 0, page: 1 },
            {
                teamRouteId: 4821,
                issueId: ISSUE_ID,
                limit: POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT + 1,
                page: 1,
            },
            { teamRouteId: 4821, issueId: ISSUE_ID, limit: 50, page: 0 },
        ]) {
            const outcome = await readPosthogIssueActivity(client, input, {});
            expect(outcome.ok).toBe(false);
            if (outcome.ok) return;
            expect(outcome.failure.kind).toBe('requestInvalid');
        }
        expect(calls).toEqual([]);
    });

    it('surfaces a missing activity scope as a typed permission failure', async () => {
        const { client } = setup(() => json({ detail: 'no' }, 403));

        const outcome = await readPosthogIssueActivity(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            limit: 50,
            page: 1,
        }, {});

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        // Until an exact missing-`activity_log:read` discriminator is characterized a
        // 403 stays a visible permission failure; it never becomes an empty page.
        expect(outcome.failure).toEqual({ kind: 'forbidden', status: 403 });
    });
});
