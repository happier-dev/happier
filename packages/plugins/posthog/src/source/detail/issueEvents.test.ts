import { describe, expect, it } from 'vitest';

import queryIssueEventsPage from '../../api/__fixtures__/queryIssueEventsPage.json' with { type: 'json' };
import { createPosthogApiClient, type PosthogTransportRequest } from '../../api/client.js';
import { POSTHOG_ISSUE_EVENTS_MAX_LIMIT } from '../../api/types/events.js';
import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../../connect/origin.js';
import { readPosthogSampledIssueEvents } from './issueEvents.js';

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error('fixture origin must normalize');
    return resolved.origin;
}

const ORIGIN = requireOrigin('https://eu.posthog.com');
const ISSUE_ID = '00000000-0000-4000-8000-000000000001';
const DETAIL_WINDOW = { from: '-30d', to: null } as const;

type Recorded = Readonly<{ url: string; method: string; body: unknown }>;

function setup(respond: (call: number) => Response) {
    const calls: Recorded[] = [];
    const client = createPosthogApiClient({
        origin: ORIGIN,
        now: () => Date.UTC(2026, 7, 14, 12, 0, 0),
        materializeHeaders: async () => ({ authorization: 'Bearer test-personal-api-key' }),
        transport: async (url: string, request: PosthogTransportRequest) => {
            calls.push({
                url,
                method: request.method,
                body: request.body === undefined ? undefined : JSON.parse(request.body),
            });
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

describe('readPosthogSampledIssueEvents', () => {
    it('sends every narrowing input explicitly, including the exact include set', async () => {
        const { client, calls } = setup(() => json(queryIssueEventsPage));

        const outcome = await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 3,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(true);
        expect(calls).toEqual([{
            url: 'https://eu.posthog.com/api/projects/4821/error_tracking/query/issue_events/',
            method: 'POST',
            body: {
                issueId: ISSUE_ID,
                dateRange: { date_from: '-30d', date_to: null },
                filterTestAccounts: false,
                // The provider filters to app frames by default, which would silently
                // hide the vendor frames the Stack Trace panel lets a reader disclose.
                onlyAppFrames: false,
                include: ['exception', 'stacktrace', 'navigation', 'correlation'],
                limit: 3,
                offset: 0,
            },
        }]);
    });

    it('never requests code variables, environment, release, or diagnostics context', async () => {
        const { client, calls } = setup(() => json(queryIssueEventsPage));

        await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 3,
            offset: 0,
        }, {});

        const body = calls[0]?.body as Readonly<{ include: readonly string[] }>;
        for (const forbidden of ['code_variables', 'environment', 'release', 'diagnostics']) {
            expect(body.include).not.toContain(forbidden);
        }
    });

    it('clamps a requested page to the provider sample ceiling and refuses a non-positive page', async () => {
        const { client, calls } = setup(() => json(queryIssueEventsPage));

        await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 500,
            offset: 0,
        }, {});
        expect((calls[0]?.body as Readonly<{ limit: number }>).limit)
            .toBe(POSTHOG_ISSUE_EVENTS_MAX_LIMIT);

        const refused = await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 0,
            offset: 0,
        }, {});
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.failure.kind).toBe('requestInvalid');
        // The refusal happens before the request boundary, so no second call was made.
        expect(calls).toHaveLength(1);
    });

    it('publishes only allowlisted sampled content and drops the raw properties bag', async () => {
        const { client } = setup(() => json(queryIssueEventsPage));

        const outcome = await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 3,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const serialized = JSON.stringify(outcome.value.events);
        expect(serialized).not.toContain('distinct_id');
        expect(serialized).not.toContain('sentinel-must-not-survive');
        expect(serialized).not.toContain('buyer@example.invalid');
        const first = outcome.value.events[0];
        expect(first?.uuid).toBe('00000000-0000-4000-8000-0000000000f1');
        expect(first?.sessionId).toBe('00000000-0000-4000-8000-0000000000c1');
        expect(first?.url).toBe('https://shop.example/checkout/summary');
        expect(first?.exceptions[0]?.frames.map((frame) => frame.function))
            .toEqual(['renderSummary', 'commitWork']);
    });

    it('charges an omitted provider row to the same page budget as an accepted one', async () => {
        const malformed = {
            ...queryIssueEventsPage,
            results: [
                (queryIssueEventsPage.results as readonly unknown[])[0],
                { uuid: '   ', properties: {} },
                { notAnEvent: true },
            ],
        };
        const { client } = setup(() => json(malformed));

        const outcome = await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 3,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // A malformed row consumes budget. Counting only mapped rows would let the page
        // report more accepted-plus-omitted items than it was allowed to read.
        expect(outcome.value.events).toHaveLength(1);
        expect(outcome.value.omittedRowCount).toBe(2);
        expect(outcome.value.events.length + outcome.value.omittedRowCount).toBeLessThanOrEqual(3);
    });

    it('claims a following page only when the provider offset actually advances', async () => {
        const advancing = await (async () => {
            const { client } = setup(() => json(queryIssueEventsPage));
            return readPosthogSampledIssueEvents(client, {
                teamRouteId: 4821,
                issueId: ISSUE_ID,
                detailWindow: DETAIL_WINDOW,
                limit: 3,
                offset: 0,
            }, {});
        })();
        expect(advancing.ok).toBe(true);
        if (!advancing.ok) return;
        expect(advancing.value.nextOffset).toBe(3);

        const stuck = await (async () => {
            const { client } = setup(() => json({ ...queryIssueEventsPage, nextOffset: 0 }));
            return readPosthogSampledIssueEvents(client, {
                teamRouteId: 4821,
                issueId: ISSUE_ID,
                detailWindow: DETAIL_WINDOW,
                limit: 3,
                offset: 0,
            }, {});
        })();
        expect(stuck.ok).toBe(true);
        if (!stuck.ok) return;
        // A provider that says "more" without moving cannot be paged; the sample ends
        // here rather than looping on the same offset.
        expect(stuck.value.nextOffset).toBeNull();
    });

    it('returns one typed failure for an unreadable envelope and publishes no partial page', async () => {
        const { client } = setup(() => json({ results: [], hasMore: 'yes' }));

        const outcome = await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 3,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.failure.kind).toBe('malformedResponse');
    });

    it('carries the frozen request geometry the selected-occurrence reread must reproduce', async () => {
        const { client } = setup(() => json(queryIssueEventsPage));

        const outcome = await readPosthogSampledIssueEvents(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
            limit: 3,
            offset: 3,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.value.request).toEqual({
            issueId: ISSUE_ID,
            dateRange: { date_from: '-30d', date_to: null },
            filterTestAccounts: false,
            onlyAppFrames: false,
            include: ['exception', 'stacktrace', 'navigation', 'correlation'],
            limit: 3,
            offset: 3,
        });
    });
});
