import { V2SessionRecordSchema, withConnectedServiceReaderSupport } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { fetchSessionListPageCompat, parseCompatSessionByIdResponse } from './sessionHttpCompat';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Minimal row that satisfies `V2SessionRecordSchema`, so the v2 branch of the
 * compat parser is the one under test rather than the legacy fallback.
 */
function rawSessionRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 's1',
        seq: 12,
        createdAt: 10,
        updatedAt: 20,
        active: true,
        activeAt: 30,
        metadata: '{}',
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
        ...overrides,
    };
}

function v2ListRequest(rows: readonly Record<string, unknown>[]) {
    return vi.fn(async (path: string) => {
        if (path.startsWith('/v2/sessions')) {
            return jsonResponse({ sessions: rows, nextCursor: null, hasNext: false });
        }
        throw new Error(`Unexpected request path: ${path}`);
    });
}

describe('fetchSessionListPageCompat', () => {
    it('keeps a near-boundary ID in a required-only overflow request when it cannot fit the account query', async () => {
        const url = new URL('/v2/sessions?limit=50&requiredOnly=true', 'https://example.test');
        url.searchParams.set('requiredSessionIds', JSON.stringify(['']));
        const overhead = `GET ${withConnectedServiceReaderSupport(url.pathname + url.search)} HTTP/1.1\r\n`.length;
        const id = 'x'.repeat(8 * 1024 - overhead);
        const paths: string[] = [];
        const page = await fetchSessionListPageCompat({
            request: async (path) => {
                paths.push(path);
                const ids: string[] = JSON.parse(new URL(path, 'https://example.test').searchParams.get('requiredSessionIds') ?? '[]');
                return jsonResponse({ sessions: ids.map((id) => rawSessionRow({ id })), hasNext: false, nextCursor: null });
            },
            token: 'token',
            sessionListPath: '/v2/sessions?includeActive=true&includeAttention=true',
            limit: 50,
            requiredSessionIds: [id],
        });
        expect(page.sessions.map((row) => row.id)).toEqual([id]);
        expect(paths).toHaveLength(2);
        for (const path of paths) {
            expect(`GET ${withConnectedServiceReaderSupport(path)} HTTP/1.1\r\n`.length).toBeLessThanOrEqual(8 * 1024);
        }
    });

    it('reports an ID that cannot fit any request instead of silently truncating it', async () => {
        const request = vi.fn();
        await expect(fetchSessionListPageCompat({
            request,
            token: 'token',
            limit: 50,
            requiredOnly: true,
            requiredSessionIds: ['x'.repeat(8 * 1024)],
        })).rejects.toThrow(/request-line limit/);
        expect(request).not.toHaveBeenCalled();
    });

    it.each(['some', 'all'] as const)('splits required rows by the request-line budget without re-requesting %s IDs already supplied by account families', async (initialCoverage) => {
        const serverUrl = `https://example.test/self-hosted/${'prefix'.repeat(40)}`;
        const requiredSessionIds = Array.from({ length: 315 }, (_, index) => `session_${String(index).padStart(4, '0')}_${'x'.repeat(12)}`);
        const initiallyIncludedIds = initialCoverage === 'all' ? requiredSessionIds : requiredSessionIds.slice(250, 270);
        const requestedPaths: string[] = [];
        const request = async (path: string) => {
            requestedPaths.push(path);
            const query = new URL(path, 'https://example.test').searchParams;
            const requiredIds: string[] = JSON.parse(query.get('requiredSessionIds') ?? '[]');
            return jsonResponse({
                sessions: [
                    ...(query.get('requiredOnly') === 'true' ? [] : [
                        rawSessionRow({ id: 'page-row' }),
                        ...initiallyIncludedIds.map((id) => rawSessionRow({ id })),
                    ]),
                    ...requiredIds.map((id) => rawSessionRow({ id })),
                ],
                nextCursor: query.get('requiredOnly') === 'true' ? null : 'page-2',
                hasNext: query.get('requiredOnly') !== 'true',
                includedActive: query.get('includeActive') === 'true',
            });
        };

        const page = await fetchSessionListPageCompat({
            request,
            token: 'token',
            sessionListPath: '/v2/sessions?includeActive=true&includeAttention=true',
            serverUrl,
            limit: 50,
            requiredSessionIds,
        });

        expect(new Set(page.sessions.map((row) => row.id))).toEqual(new Set(['page-row', ...requiredSessionIds]));
        expect(page.sessions).toHaveLength(requiredSessionIds.length + 1);
        expect(page).toMatchObject({ nextCursor: 'page-2', hasNext: true, includedActiveRows: true });
        if (initialCoverage === 'all') expect(requestedPaths).toHaveLength(1);
        else expect(requestedPaths.length).toBeGreaterThan(1);
        for (const [index, path] of requestedPaths.entries()) {
            const requestUrl = new URL(withConnectedServiceReaderSupport(serverUrl + path));
            expect(`GET ${requestUrl.pathname}${requestUrl.search} HTTP/1.1\r\n`.length).toBeLessThanOrEqual(8 * 1024);
            const query = new URL(path, 'https://example.test').searchParams;
            if (index === 0) expect(query.get('includeActive')).toBe('true');
            else {
                expect(query.get('requiredOnly')).toBe('true');
                expect(query.has('includeActive')).toBe(false);
                expect(query.has('includeAttention')).toBe(false);
                expect(query.has('cursor')).toBe(false);
                const requestedIds: string[] = JSON.parse(query.get('requiredSessionIds') ?? '[]');
                expect(requestedIds.filter((id) => initiallyIncludedIds.includes(id))).toEqual([]);
            }
        }
    });

    it('filters required-only rows from a server that ignores the new query and does not borrow account pagination', async () => {
        const requiredSessionIds = Array.from({ length: 315 }, (_, index) => `session_${String(index).padStart(4, '0')}_${'x'.repeat(12)}`);
        const request = vi.fn(async () => jsonResponse({
            sessions: [rawSessionRow({ id: 'unrelated' }), ...requiredSessionIds.map((id) => rawSessionRow({ id }))],
            nextCursor: 'ordinary-page-2',
            hasNext: true,
        }));
        const page = await fetchSessionListPageCompat({
            request,
            token: 'token',
            limit: 50,
            requiredSessionIds: ['omitted', ...requiredSessionIds],
            requiredOnly: true,
        });

        expect(page.sessions.map((row) => row.id)).toEqual(requiredSessionIds);
        expect(page).toMatchObject({ nextCursor: null, hasNext: false });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not reinterpret incomplete session-row projections as current activity', async () => {
        const request = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=50') {
                return jsonResponse({ error: 'Not found', path: '/v2/sessions' }, 404);
            }
            if (path === '/v1/sessions') {
                return jsonResponse({
                    sessions: [{
                        id: 's1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 30,
                        metadata: '{}',
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 0,
                        dataEncryptionKey: null,
                        runtimeActivityActiveCount: 2,
                        runtimeActivityObservedAt: 40,
                    }],
                });
            }
            throw new Error(`Unexpected request path: ${path}`);
        });

        const page = await fetchSessionListPageCompat({
            request,
            token: 'token',
            limit: 50,
        });

        expect(page.source).toBe('v1');
        expect(page.sessions[0]).not.toEqual(expect.objectContaining({
            runtimeActivityRevision: expect.anything(),
        }));
    });

    it('still falls back to /v1/sessions when the initial page carries row-family query flags', async () => {
        // The initial page asks for extra row families through the query string. A server without
        // /v2/sessions at all must still be recognised: route identity is the path, not the query.
        const request = vi.fn(async (path: string) => {
            if (path.startsWith('/v2/sessions?')) {
                return jsonResponse({ error: 'Not found', path: '/v2/sessions' }, 404);
            }
            if (path === '/v1/sessions') {
                return jsonResponse({ sessions: [rawSessionRow()] });
            }
            throw new Error(`Unexpected request path: ${path}`);
        });

        const page = await fetchSessionListPageCompat({
            request,
            token: 'token',
            sessionListPath: '/v2/sessions?includeActive=true&includeAttention=true',
            limit: 50,
        });

        expect(page.source).toBe('v1');
        expect(page.includedActiveRows).toBe(false);
    });

    it('does not divert a sibling /v2/sessions/... route to the legacy list', async () => {
        const requestedPaths: string[] = [];
        const request = vi.fn(async (path: string) => {
            requestedPaths.push(path);
            return jsonResponse({ error: 'Not found', path: '/v2/sessions/active' }, 404);
        });

        await expect(fetchSessionListPageCompat({
            request,
            token: 'token',
            sessionListPath: '/v2/sessions/active',
            limit: 500,
        })).rejects.toThrow();
        expect(requestedPaths).toEqual(['/v2/sessions/active?limit=500']);
    });

    it('reports the merged active-row family only when the server advertises it', async () => {
        const advertising = vi.fn(async () => jsonResponse({
            includedActive: true,
            sessions: [rawSessionRow()],
            nextCursor: null,
            hasNext: false,
        }));
        const silent = vi.fn(async () => jsonResponse({
            sessions: [rawSessionRow()],
            nextCursor: null,
            hasNext: false,
        }));

        const advertised = await fetchSessionListPageCompat({ request: advertising, token: 'token', limit: 50 });
        const unadvertised = await fetchSessionListPageCompat({ request: silent, token: 'token', limit: 50 });

        expect(advertised.includedActiveRows).toBe(true);
        expect(unadvertised.includedActiveRows).toBe(false);
    });

});

describe('session record coercion carries the server-materialized unread entry fact', () => {
    const UNREAD_SINCE_MS = 1_700_000_000_000;

    it('carries unreadSince through the v2 list path', async () => {
        const request = v2ListRequest([rawSessionRow({ unreadSince: UNREAD_SINCE_MS })]);

        const page = await fetchSessionListPageCompat({ request, token: 'token', limit: 50 });

        // Pins the branch under test: this row parses against the v2 schema, so
        // the value survived the schema parse *and* the record rebuild.
        expect(page.source).toBe('v2');
        expect(page.sessions[0]?.unreadSince).toBe(UNREAD_SINCE_MS);
    });

    it('carries unreadSince through the session-by-id path', () => {
        const parsed = parseCompatSessionByIdResponse({
            session: rawSessionRow({ unreadSince: UNREAD_SINCE_MS }),
        });

        expect(parsed?.session.id).toBe('s1');
        expect(parsed?.session.unreadSince).toBe(UNREAD_SINCE_MS);
    });

    it('normalizes a nullable rollback projection to absence', () => {
        const parsed = parseCompatSessionByIdResponse({
            session: rawSessionRow({ rollbackEligibleTurnStarts: null }),
        });

        expect(parsed?.session.rollbackEligibleTurnStarts).toBeUndefined();
    });

    it('coerces a row from a server that does not send unreadSince to null', async () => {
        const request = v2ListRequest([rawSessionRow()]);

        const page = await fetchSessionListPageCompat({ request, token: 'token', limit: 50 });

        // Additive field: an older server must still produce a complete row, and
        // the absent value must read as "no server stamp" (null), never as a
        // number the merge owner would treat as authoritative.
        expect(page.source).toBe('v2');
        expect(page.sessions[0]?.id).toBe('s1');
        expect(page.sessions[0]?.seq).toBe(12);
        expect(page.sessions[0]?.unreadSince).toBeNull();
    });

    it('rejects a non-numeric unreadSince instead of forwarding it', async () => {
        const request = v2ListRequest([rawSessionRow({ unreadSince: 'not-a-number' })]);

        const page = await fetchSessionListPageCompat({ request, token: 'token', limit: 50 });

        expect(page.sessions[0]?.unreadSince).toBeNull();
    });

    it('normalizes a legacy null rollback eligibility projection to absent', () => {
        const current = parseCompatSessionByIdResponse({
            session: rawSessionRow({ rollbackEligibleTurnStarts: [1, 3] }),
        });
        const parsed = parseCompatSessionByIdResponse({
            session: rawSessionRow({ rollbackEligibleTurnStarts: null }),
        });

        expect(current?.session.rollbackEligibleTurnStarts).toEqual([1, 3]);
        expect(parsed?.session.rollbackEligibleTurnStarts).toBeUndefined();
    });

    it('KEYSTONE: rebuilds a carrier for every field the protocol record schema declares', async () => {
        // The record rebuild is an allow-list, so a newly declared protocol field
        // is silently dropped unless a carrier is added here too — the exact way
        // `unreadSince` was lost. Deriving the expectation from the schema shape
        // makes that class of omission fail instead of pass.
        const declaredFields = Object.keys(V2SessionRecordSchema.shape);
        const request = v2ListRequest([rawSessionRow({
            meaningfulActivityAt: 25,
            archivedAt: null,
            encryptionMode: 'plain',
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
            latestReadyEventSeq: 4,
            latestReadyEventAt: 26,
            thinking: false,
            thinkingAt: 0,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 1,
            pendingActivationAuthorization: {
                status: 'waiting',
                requestId: 'activation-1',
                requestedAt: 28,
            },
            share: { accessLevel: 'edit', canApprovePermissions: true },
            latestTurnId: 't1',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 27,
            lastRuntimeIssue: null,
        })]);

        const page = await fetchSessionListPageCompat({ request, token: 'token', limit: 50 });
        const coerced = page.sessions[0];

        expect(coerced).toBeDefined();
        expect(declaredFields.length).toBeGreaterThan(20);
        const missing = declaredFields.filter((field) => !(field in (coerced as Record<string, unknown>)));
        expect(missing).toEqual([]);
        expect(coerced?.pendingActivationAuthorization).toEqual({
            status: 'waiting',
            requestId: 'activation-1',
            requestedAt: 28,
        });
    });
});
