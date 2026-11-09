import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchChanges, fetchCurrentChangesCursor } from './apiChanges';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { ServerFetch } from '@/sync/http/client';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

const credentials: AuthCredentials = { token: createAccountTokenForTests('changes-account'), secret: 's' };
const endpointFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function okJson(payload: unknown) {
    return Response.json(payload);
}

function errorJson(status: number, payload: unknown) {
    return Response.json(payload, { status });
}

describe('apiChanges', () => {
    beforeEach(async () => {
        endpointFetch.mockReset();
        resetServerFeaturesClientForTests();
        await upsertAndActivateServer({ serverUrl: 'https://api.test.com', name: 'Changes Home' });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({});
            return await endpointFetch(input, init);
        }));
    });

    afterEach(async () => {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('keeps one GET URL across advancing cursors when the Home advertises cursor headers', async () => {
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { changes: { cursorHeaderVersion: 1 } },
        }) } });
        endpointFetch.mockImplementation(async (_input, init) => {
            const after = new Headers(init?.headers).get('x-happier-changes-after');
            const cursor = Number(after) + 1;
            return Response.json({ changes: [{ cursor, kind: 'session', entityId: 's1', changedAt: 1, hint: null }], nextCursor: cursor },
                { headers: { 'x-happier-changes-after': String(after) } });
        });

        const first = await fetchChanges({ credentials, afterCursor: '1', limit: 50 });
        const second = await fetchChanges({ credentials, afterCursor: '3', limit: 50 });
        const urls = endpointFetch.mock.calls.map(([input]) => String(input));
        expect(new Set(urls).size).toBe(1);
        expect(new URL(urls[0]!).searchParams.has('after')).toBe(false);
        expect(endpointFetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-happier-changes-after'))).toEqual(['1', '3']);
        expect(first).toMatchObject({ status: 'ok', changes: [{ cursor: 2 }], nextCursor: '2' });
        expect(second).toMatchObject({ status: 'ok', changes: [{ cursor: 4 }], nextCursor: '4' });
    });

    it('returns ok + nextCursor on success', async () => {
        endpointFetch.mockResolvedValue(
            okJson({
                changes: [{ cursor: 2, kind: 'session', entityId: 's1', changedAt: 1, hint: null }],
                nextCursor: 2,
            }),
        );

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 50 });

        expect(res).toEqual({
            status: 'ok',
            changes: [{ cursor: 2, kind: 'session', entityId: 's1', changedAt: 1, hint: null }],
            nextCursor: '2',
        });
        expect(global.fetch).toHaveBeenCalledWith('https://api.test.com/v2/changes?after=1&limit=50', expect.any(Object));
        const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const call = calls.find(([input]) => String(input) === 'https://api.test.com/v2/changes?after=1&limit=50');
        const requestInit = call?.[1] as RequestInit | undefined;
        expect(requestInit).toBeDefined();
        expect(requestInit?.headers).toBeInstanceOf(Headers);
        expect((requestInit!.headers as Headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
    });

    it('refuses an unacknowledged header cursor rather than accepting an older server page from zero', async () => {
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { changes: { cursorHeaderVersion: 1 } },
        }) } });
        endpointFetch.mockResolvedValue(okJson({ changes: [], nextCursor: 100 }));
        expect(await fetchChanges({ credentials, afterCursor: '40', limit: 50 })).toEqual({ status: 'error' });
    });

    it('uses the captured Home support for a scoped request and leaves opaque or older-Home requests on query cursors', async () => {
        const supportedHome = getActiveServerSnapshot().serverId;
        primeServerFeaturesSnapshot({ serverId: supportedHome, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { changes: { cursorHeaderVersion: 1 } },
        }) } });
        const olderHome = await upsertAndActivateServer({ serverUrl: 'https://older-home.test', name: 'Older Home' });
        primeServerFeaturesSnapshot({ serverId: olderHome.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: {},
        }) } });
        const request = vi.fn<ServerFetch>(async (_path, init) => {
            const after = new Headers(init?.headers).get('x-happier-changes-after');
            return Response.json({ changes: [], nextCursor: 90 }, { headers: after ? { 'x-happier-changes-after': after } : {} });
        });
        for (const serverId of [supportedHome, olderHome.id, undefined]) {
            expect(await fetchChanges({ credentials, request, serverId, afterCursor: '90', limit: 50, sessionId: 'session-scoped' }))
                .toMatchObject({ status: 'ok', nextCursor: '90' });
        }
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            '/v2/changes?limit=50&sessionId=session-scoped',
            '/v2/changes?after=90&limit=50&sessionId=session-scoped',
            '/v2/changes?after=90&limit=50&sessionId=session-scoped',
        ]);
        expect(request.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-happier-changes-after'))).toEqual(['90', null, null]);
    });

    it('returns cursor-gone for 410 responses', async () => {
        endpointFetch.mockResolvedValue(
            errorJson(410, { error: 'cursor-gone', currentCursor: 9 }),
        );

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 200 });
        expect(res).toEqual({ status: 'cursor-gone', currentCursor: '9' });
    });

    it('returns error when /v2/changes is missing (e.g. old server 404)', async () => {
        endpointFetch.mockResolvedValue(errorJson(404, { error: 'not-found' }));

        const res = await fetchChanges({ credentials, afterCursor: '0', limit: 200 });
        expect(res).toEqual({ status: 'error' });
    });

    it('returns cursor-gone with fallback cursor when 410 body is invalid', async () => {
        endpointFetch.mockResolvedValue(new Response('invalid json', { status: 410 }));

        const res = await fetchChanges({ credentials, afterCursor: '5', limit: 200 });
        expect(res).toEqual({ status: 'cursor-gone', currentCursor: '0' });
    });

    it('returns error when fetch throws (network failure)', async () => {
        endpointFetch.mockRejectedValue(new Error('network down'));

        const res = await fetchChanges({ credentials, afterCursor: '1', limit: 200 });
        expect(res).toEqual({ status: 'error' });
    });

    it('normalizes invalid afterCursor and clamps limit', async () => {
        endpointFetch.mockResolvedValue(
            okJson({
                changes: [],
                nextCursor: 0,
            }),
        );

        await fetchChanges({ credentials, afterCursor: '-100', limit: 10_000 });
        expect(global.fetch).toHaveBeenCalledWith('https://api.test.com/v2/changes?after=0&limit=500', expect.any(Object));
    });

    it('returns the current cursor from /v2/cursor', async () => {
        endpointFetch.mockResolvedValue(okJson({ cursor: 42, changesFloor: 7 }));

        const res = await fetchCurrentChangesCursor({ credentials });

        expect(res).toEqual({ status: 'ok', cursor: '42' });
        expect(global.fetch).toHaveBeenCalledWith('https://api.test.com/v2/cursor', expect.any(Object));
        const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
        const call = calls.find(([input]) => String(input) === 'https://api.test.com/v2/cursor');
        const requestInit = call?.[1] as RequestInit | undefined;
        expect(requestInit).toBeDefined();
        expect(requestInit?.headers).toBeInstanceOf(Headers);
        expect((requestInit!.headers as Headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
    });

    it('returns error when /v2/cursor payload is invalid', async () => {
        endpointFetch.mockResolvedValue(okJson({ cursor: -1, changesFloor: 0 }));

        const res = await fetchCurrentChangesCursor({ credentials });

        expect(res).toEqual({ status: 'error' });
    });

    it('returns error when /v2/cursor fetch throws', async () => {
        endpointFetch.mockRejectedValue(new Error('network down'));

        const res = await fetchCurrentChangesCursor({ credentials });

        expect(res).toEqual({ status: 'error' });
    });
});
