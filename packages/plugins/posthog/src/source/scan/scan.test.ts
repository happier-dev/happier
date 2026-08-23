import { describe, expect, it } from 'vitest';

import page1 from '../../api/__fixtures__/queryIssuesPage1.json' with { type: 'json' };
import page2 from '../../api/__fixtures__/queryIssuesPage2.json' with { type: 'json' };
import tolerantPage from '../../api/__fixtures__/queryIssuesTolerantPage.json' with { type: 'json' };
import {
    createPosthogApiClient,
    type PosthogTransportRequest,
} from '../../api/client.js';
import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../../connect/origin.js';
import { scanPosthogIssuePage, type PosthogScanEnvironment } from './scan.js';

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error(`fixture origin must normalize: ${raw}`);
    return resolved.origin;
}

const ORIGIN = requireOrigin('https://eu.posthog.com');
const WINDOW = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-14T00:00:00.000Z' } as const;
const ENV_A: PosthogScanEnvironment = {
    teamRouteId: 4821,
    teamUuid: '00000000-0000-4000-8000-0000000000d1',
};
const ENV_B: PosthogScanEnvironment = {
    teamRouteId: 4822,
    teamUuid: '00000000-0000-4000-8000-0000000000d2',
};

type Recorded = Readonly<{ url: string; body: unknown }>;

function setup(respond: (call: number, body: unknown, url: string) => Response) {
    const calls: Recorded[] = [];
    const client = createPosthogApiClient({
        origin: ORIGIN,
        now: () => Date.UTC(2026, 7, 14, 12, 0, 0),
        materializeHeaders: async () => ({ ok: true, authorization: 'Bearer test-personal-api-key' }),
        transport: async (url: string, request: PosthogTransportRequest) => {
            const body = request.body === undefined ? undefined : JSON.parse(request.body);
            calls.push({ url, body });
            return respond(calls.length, body, url);
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

/**
 * `scanPosthogIssuePage` is the one owner of what a PostHog issues page means, and the
 * one function `src/source/operations.ts` drives. There is deliberately no second
 * whole-window walk beside it: the walk across environments and offsets lives in the
 * bound scan operation and rides back in its opaque continuation, so a page owner that
 * looped internally would be a second, contradicting paging decision.
 */
describe('scanPosthogIssuePage request shape', () => {
    it('sends every narrowing input explicitly so no server default silently applies', async () => {
        const { client, calls } = setup(() => json(page2));

        await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 50,
            offset: 0,
        }, {});

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url)
            .toBe('https://eu.posthog.com/api/projects/4821/error_tracking/query/issues/');
        expect(calls[0]?.body).toEqual({
            dateRange: { date_from: WINDOW.from, date_to: WINDOW.to },
            status: 'all',
            filterTestAccounts: false,
            orderBy: 'first_seen',
            orderDirection: 'ASC',
            limit: 50,
            offset: 0,
            volumeResolution: 0,
        });
        // `includeSparkline` is not a key of the issues-list request.
        expect(Object.keys(calls[0]?.body as object).sort()).toEqual([
            'dateRange',
            'filterTestAccounts',
            'limit',
            'offset',
            'orderBy',
            'orderDirection',
            'status',
            'volumeResolution',
        ]);
    });

    it('issues exactly one provider request even when the provider claims more rows', async () => {
        const { client, calls } = setup(() => json(page1));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(calls).toHaveLength(1);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.hasMore).toBe(true);
    });

    it('sends the caller-frozen page size and offset unchanged rather than deriving its own', async () => {
        const { client, calls } = setup(() => json({ ...page2, offset: 12 }));

        await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_B,
            window: WINDOW,
            nativeLimit: 100,
            offset: 12,
        }, {});

        expect(calls[0]?.url)
            .toBe('https://eu.posthog.com/api/projects/4822/error_tracking/query/issues/');
        expect(calls[0]?.body).toMatchObject({ limit: 100, offset: 12 });
    });

    it('refuses an unusable team route before reaching the request boundary', async () => {
        const { client, calls } = setup(() => json(page2));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: { teamRouteId: 0, teamUuid: ENV_A.teamUuid },
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(calls).toHaveLength(0);
        expect(outcome).toEqual({
            ok: false,
            failure: { kind: 'requestInvalid', at: 'teamRouteId' },
            uninterpretable: true,
        });
    });
});

describe('scanPosthogIssuePage paging geometry', () => {
    it('reports the provider next offset as a candidate the caller still has to validate', async () => {
        const { client } = setup(() => json(page1));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.observations).toHaveLength(3);
        expect(outcome.malformedRowCount).toBe(0);
        expect(outcome.hasMore).toBe(true);
        expect(outcome.nextOffsetCandidate).toBe(3);
    });

    it('falls back to the offset plus the returned row count when nextOffset is absent', async () => {
        const { client } = setup(() => json({ ...page1, nextOffset: undefined }));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 6,
        }, {});

        expect(outcome.ok && outcome.nextOffsetCandidate).toBe(9);
    });

    it('offers no candidate at all once the provider reports the end of the environment', async () => {
        const { client } = setup(() => json(page2));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 3,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.hasMore).toBe(false);
        expect(outcome.nextOffsetCandidate).toBeNull();
    });

    it('surfaces a stuck provider offset as a non-advancing candidate instead of hiding it', async () => {
        const { client } = setup(() => json({ ...page1, hasMore: true, nextOffset: 0 }));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // The page owner reports what the provider said; only the caller, which knows
        // the offset it asked for, may decide that the walk cannot advance.
        expect(outcome.hasMore).toBe(true);
        expect(outcome.nextOffsetCandidate).toBe(0);
    });
});

describe('scanPosthogIssuePage identity and row tolerance', () => {
    it('scopes the same issue id under two environments as two distinct entries', async () => {
        const { client } = setup(() => json(page2));

        const first = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});
        const second = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_B,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(first.observations.map((observation) => observation.locator.entryId))
            .toEqual(second.observations.map((observation) => observation.locator.entryId));
        const scopes = new Set([
            ...first.observations.map((observation) => observation.locator.collisionScope),
            ...second.observations.map((observation) => observation.locator.collisionScope),
        ]);
        expect(scopes.size).toBe(2);
    });

    it('skips a malformed row while keeping every valid row from the same page', async () => {
        const { client } = setup(() => json(tolerantPage));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 5,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.observations.map((observation) => observation.locator.entryId)).toEqual([
            '00000000-0000-4000-8000-000000000010',
            '00000000-0000-4000-8000-000000000014',
        ]);
        expect(outcome.malformedRowCount).toBe(3);
        expect(outcome.hasMore).toBe(false);
    });

    it('counts every row of an unidentifiable environment rather than returning a silently empty page', async () => {
        const { client } = setup(() => json(page1));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            // A Team route id is not stable identity, so a non-UUID Team UUID fails
            // closed for the whole page instead of minting a substitute scope.
            environment: { teamRouteId: 4821, teamUuid: 'team-4821' },
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.observations).toEqual([]);
        expect(outcome.malformedRowCount).toBe(3);
    });
});

describe('scanPosthogIssuePage failure handling', () => {
    it('calls an unreadable envelope uninterpretable because its geometry is unusable', async () => {
        const { client } = setup(() => json({ results: [], limit: 3, offset: 0 }));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(outcome).toEqual({
            ok: false,
            failure: { kind: 'malformedResponse', at: 'schema' },
            uninterpretable: true,
        });
    });

    it('returns a throttle as an interpretable failure without retrying or waiting', async () => {
        const { client, calls } = setup(
            () => json({ detail: 'throttled' }, 429, { 'retry-after': '30' }),
        );

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, {});

        expect(calls).toHaveLength(1);
        expect(outcome).toEqual({
            ok: false,
            failure: {
                kind: 'rateLimited',
                status: 429,
                retryNotBeforeMs: Date.UTC(2026, 7, 14, 12, 0, 30),
            },
            uninterpretable: false,
        });
        // Nothing resembling a retained frontier leaves the page owner.
        expect(JSON.stringify(outcome)).not.toContain('cursor');
    });

    it('surfaces caller cancellation as cancellation rather than an interpretable page', async () => {
        const controller = new AbortController();
        controller.abort();
        const { client, calls } = setup(() => json(page1));

        const outcome = await scanPosthogIssuePage(client, {
            origin: ORIGIN,
            environment: ENV_A,
            window: WINDOW,
            nativeLimit: 3,
            offset: 0,
        }, { signal: controller.signal });

        expect(calls).toHaveLength(0);
        expect(outcome).toEqual({
            ok: false,
            failure: { kind: 'cancelled' },
            uninterpretable: false,
        });
    });
});
