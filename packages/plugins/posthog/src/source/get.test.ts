import { describe, expect, it } from 'vitest';

import crudIssueRead from '../api/__fixtures__/crudIssueRead.json' with { type: 'json' };
import queryIssueDetail from '../api/__fixtures__/queryIssueDetail.json' with { type: 'json' };
import { createPosthogApiClient, type PosthogTransportRequest } from '../api/client.js';
import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../connect/origin.js';
import { getPosthogIssue } from './get.js';
import { resolvePosthogCrudFailure } from './issueResolution.js';

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error('fixture origin must normalize');
    return resolved.origin;
}

const ORIGIN = requireOrigin('https://eu.posthog.com');
const ISSUE_ID = '00000000-0000-4000-8000-000000000001';
const DETAIL_WINDOW = { from: '-30d', to: null } as const;

type Recorded = Readonly<{ url: string; method: string; body: unknown }>;

function setup(respond: (call: number, url: string) => Response) {
    const calls: Recorded[] = [];
    const client = createPosthogApiClient({
        origin: ORIGIN,
        now: () => Date.UTC(2026, 7, 14, 12, 0, 0),
        materializeHeaders: async () => ({ ok: true, authorization: 'Bearer test-personal-api-key' }),
        transport: async (url: string, request: PosthogTransportRequest) => {
            calls.push({
                url,
                method: request.method,
                body: request.body === undefined ? undefined : JSON.parse(request.body),
            });
            return respond(calls.length, url);
        },
    });
    return { client, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

describe('getPosthogIssue', () => {
    it('reads CRUD first and only then joins the query plane', async () => {
        const { client, calls } = setup((call) => json(call === 1 ? crudIssueRead : queryIssueDetail));

        const outcome = await getPosthogIssue(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
        }, {});

        expect(calls).toEqual([
            {
                url: `https://eu.posthog.com/api/projects/4821/error_tracking/issues/${ISSUE_ID}/`,
                method: 'GET',
                body: undefined,
            },
            {
                url: 'https://eu.posthog.com/api/projects/4821/error_tracking/query/issue/',
                method: 'POST',
                body: {
                    issueId: ISSUE_ID,
                    dateRange: { date_from: '-30d', date_to: null },
                    filterTestAccounts: false,
                    volumeResolution: 0,
                    includeSparkline: false,
                },
            },
        ]);
        expect(outcome.kind).toBe('present');
        if (outcome.kind !== 'present') return;
        // Severity exists only on CRUD; last seen and aggregations only on the query plane.
        expect(outcome.crud.severity).toBe('high');
        expect(outcome.crud.externalIssueCount).toBe(1);
        expect(outcome.crud.cohortName).toBe('Checkout regressions');
        expect(outcome.queryDetail?.lastSeenMs)
            .toBe(Date.parse('2026-08-14T06:41:55.902000Z'));
        expect(outcome.queryDetail?.aggregations)
            .toEqual({ occurrences: 1842, users: 311, sessions: 402 });
        expect(outcome.queryDetail?.latestRelease?.version).toBe('2026.8.12');
    });

    it('keeps the entry present when the query plane 404s for the configured window', async () => {
        const { client, calls } = setup((call) => (call === 1
            ? json(crudIssueRead)
            : json({ detail: 'Issue not found' }, 404)));

        const outcome = await getPosthogIssue(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
        }, {});

        expect(calls).toHaveLength(2);
        expect(outcome).toMatchObject({
            kind: 'present',
            enrichmentFailure: { kind: 'notFound', status: 404 },
        });
        expect(outcome.kind === 'present' && outcome.queryDetail).toBeUndefined();
    });

    it('returns unresolved on a plain CRUD 404 and never calls the query plane', async () => {
        const { client, calls } = setup(() => json({ detail: 'Not found.' }, 404));

        const outcome = await getPosthogIssue(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
        }, {});

        expect(calls).toHaveLength(1);
        expect(outcome).toEqual({
            kind: 'unresolved',
            resolution: {
                kind: 'unresolved',
                failure: { kind: 'notFound', status: 404 },
            },
        });
        expect(JSON.stringify(outcome)).not.toContain('absent');
        expect(JSON.stringify(outcome)).not.toContain('merged');
    });

    it('never follows a fingerprint-qualified successor redirect it did not ask for', async () => {
        // V1 sends no fingerprint, so the provider cannot name a successor. If a
        // redirect arrives anyway it must not be followed into a different issue.
        const { client, calls } = setup(() => new Response(null, {
            status: 308,
            headers: {
                location: 'https://eu.posthog.com/api/projects/4821/error_tracking/issues/00000000-0000-4000-8000-000000000099/',
            },
        }));

        const outcome = await getPosthogIssue(client, {
            teamRouteId: 4821,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
        }, {});

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain(ISSUE_ID);
        expect(outcome).toEqual({
            kind: 'unresolved',
            resolution: {
                kind: 'unresolved',
                failure: { kind: 'redirected', status: 308 },
            },
        });
    });

    it('never calls the query plane after any CRUD failure', async () => {
        for (const response of [
            json({}, 401),
            json({}, 403),
            json({}, 429, { 'retry-after': '10' }),
            json({}, 503),
        ]) {
            const { client, calls } = setup(() => response.clone());
            const outcome = await getPosthogIssue(client, {
                teamRouteId: 4821,
                issueId: ISSUE_ID,
                detailWindow: DETAIL_WINDOW,
            }, {});

            expect(calls).toHaveLength(1);
            expect(outcome.kind).toBe('unresolved');
        }
    });

    it('rejects a non-routable Team id before issuing any request', async () => {
        const { client, calls } = setup(() => json(crudIssueRead));

        const outcome = await getPosthogIssue(client, {
            teamRouteId: 0,
            issueId: ISSUE_ID,
            detailWindow: DETAIL_WINDOW,
        }, {});

        expect(calls).toHaveLength(0);
        expect(outcome).toEqual({
            kind: 'unresolved',
            resolution: {
                kind: 'unresolved',
                failure: { kind: 'requestInvalid', at: 'teamRouteId' },
            },
        });
    });
});

describe('resolvePosthogCrudFailure', () => {
    it('maps every failure to unresolved and emits neither absence nor merge', () => {
        const failures = [
            { kind: 'notFound', status: 404 },
            { kind: 'unauthorized', status: 401 },
            { kind: 'forbidden', status: 403 },
            { kind: 'rateLimited', status: 429 },
            { kind: 'redirected', status: 308 },
            { kind: 'server', status: 500 },
            { kind: 'unexpectedStatus', status: 418 },
            { kind: 'transport' },
            { kind: 'timeout' },
            { kind: 'cancelled' },
            { kind: 'malformedResponse', at: 'schema' },
            { kind: 'originMismatch' },
            { kind: 'requestInvalid', at: 'teamRouteId' },
        ] as const;

        for (const failure of failures) {
            const resolution = resolvePosthogCrudFailure(failure);
            expect(resolution.kind).toBe('unresolved');
            expect(JSON.stringify(resolution)).not.toContain('absent');
            expect(JSON.stringify(resolution)).not.toContain('merged');
            // The provider's own classified failure travels WHOLE. Anything this
            // reduced to first — a reason word, a class, a code — would be a
            // second classification of the same response, and the last one
            // dropped the `Retry-After` deadline `scan` reports for the identical
            // condition.
            expect(resolution.failure).toEqual(failure);
            expect(Object.keys(resolution).sort()).toEqual(['failure', 'kind']);
        }
    });
});
