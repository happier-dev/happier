import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    encodeV2SessionListCursorV2,
    type V2SessionRecord,
} from '@happier-dev/protocol/sessions/control/contract';
import {
    projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    type AccountEncryptionCurrentnessResponse} from '@happier-dev/protocol/account/encryptionMode';
import {
    type SessionListQueryV1} from '@happier-dev/protocol/sessions/listing/query';

import { fetchAndApplySessions as fetchAndApplySessionsSource } from './sessionSnapshot';
import { createCompactSessionListFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

function fetchAndApplySessions(params: Parameters<typeof fetchAndApplySessionsSource>[0]) {
    const request = params.request;
    return fetchAndApplySessionsSource({ ...params,
        ...(request ? { request: createCompactSessionListFetchBoundary(async (path, init) => path === '/v2/sessions/read-batch'
            ? undefined : request(path, init)) } : {}),
    });
}

const PLAIN_ACCOUNT_CURRENTNESS = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

function buildSessionRow(id: string): V2SessionRecord {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: JSON.stringify({ path: `/${id}`, host: 'test' }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        dataEncryptionKey: null,
        encryptionMode: 'plain',
        share: null,
        effectiveAccess: {
            v: 1,
            level: 'owner',
            sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
        },
        viewer: createSessionViewerFixture(),
        responsibleAccountId: null,
        responsibleAccount: null,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function buildQuery(): SessionListQueryV1 {
    return {
        v: 1,
        storage: 'active',
        includeInactive: false,
        scope: 'all_accessible',
        attention: 'any',
        audiences: { include: [{ kind: 'team', teamId: 'team-a' }], exclude: [] },
        tagIds: { include: ['tag-a'], exclude: [] },
        includeAttention: true,
    };
}

describe('fetchAndApplySessions query source', () => {
    it('refreshes 400 rows without reading Account currentness when owner metadata and recipient readiness are not needed', async () => {
        const rows = Array.from({ length: 400 }, (_, index) => buildSessionRow(`no-owner-${index}`));
        const paths: string[] = [];
        const published: string[][] = [];
        await fetchAndApplySessions({
            serverId: 'home-a', source: { kind: 'query', body: buildQuery(), allowV1Fallback: false },
            credentials: { token: 't' }, encryption: null, sessionDataKeys: new Map(),
            request: async path => {
                paths.push(path);
                return path === '/v1/account/encryption/currentness' ? jsonResponse(PLAIN_ACCOUNT_CURRENTNESS)
                    : jsonResponse({ sessions: rows, nextCursor: null, hasNext: false,
                        attentionNextCursor: null, attentionHasNext: false });
            },
            applySessions: () => {}, applySessionListRenderables: next => published.push(next.map(row => row.id)),
            awaitSessionListHydration: true, log: { log: () => {} },
        });
        expect(published.at(-1)).toEqual(rows.map(row => row.id));
        expect(paths.filter(path => path === '/v1/account/encryption/currentness')).toHaveLength(0);
    });

    it('publishes the same-version current request address using only the existing list read', async () => {
        const row = { ...buildSessionRow('list-request'), pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0, pendingRequestObservedAt: 4,
            agentState: JSON.stringify({ requests: { permission: {
                kind: 'permission', tool: 'Bash', arguments: { private: 'body' }, createdAt: 4, turnId: 'turn-a',
            } } }),
        };
        const current = createSessionListRenderableSessionFixture({ id: row.id, active: true,
            metadataVersion: row.metadataVersion, agentStateVersion: row.agentStateVersion,
            hasPendingPermissionRequests: true, hasPendingUserActionRequests: false, pendingRequestObservedAt: 4,
        });
        const patches: unknown[] = [];
        const requestPaths: string[] = [];
        const appliedSessions: unknown[] = [];
        await fetchAndApplySessions({
            serverId: 'home-a', source: { kind: 'query', body: { ...buildQuery(), includeAttention: false }, allowV1Fallback: false },
            credentials: { token: 't' }, accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null, sessionDataKeys: new Map(),
            request: async path => { requestPaths.push(path); return jsonResponse({ sessions: [row], nextCursor: null, hasNext: false,
                attentionNextCursor: null, attentionHasNext: false }); },
            applySessions: sessions => appliedSessions.push(...sessions), applySessionListRenderables: () => {},
            applySessionListRenderablePatches: next => patches.push(...next),
            getCurrentSessionListRenderable: () => current, priorityHydrationSessionIds: [row.id], log: { log: () => {} },
        });
        await vi.waitFor(() => expect(patches).toContainEqual(expect.objectContaining({
            sessionId: row.id, patch: expect.objectContaining({ currentRequestRef: {
                kind: 'permission', requestId: 'permission', turnId: 'turn-a',
            } }),
        })));
        expect(requestPaths).toEqual(['/v2/sessions/query']);
        expect(appliedSessions).toEqual([]);
    });

    it('applies newer Agent state to a list row even when the hydrated snapshot has older row timestamps', async () => {
        const row = {
            ...buildSessionRow('agent-mixed'),
            seq: 2, updatedAt: 5, agentStateVersion: 2,
            agentState: JSON.stringify({ requests: { request: { tool: 'tool', arguments: {}, createdAt: 4 } } }),
        };
        const current = createSessionListRenderableSessionFixture({
            id: row.id, seq: 10, updatedAt: 10, metadataLayoutVersion: 0,
            metadataVersion: 1, agentStateVersion: 1,
            hasPendingPermissionRequests: false, hasPendingUserActionRequests: false,
        });
        const patches: unknown[] = [];
        await fetchAndApplySessions({
            serverId: 'home-a',
            credentials: { token: 't' }, accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null, sessionDataKeys: new Map(),
            request: async () => jsonResponse({ sessions: [row], nextCursor: null, hasNext: false }),
            applySessions: () => {}, applySessionListRenderables: () => {},
            applySessionListRenderablePatches: (next) => patches.push(...next),
            getCurrentSessionListRenderable: () => current,
            priorityHydrationSessionIds: [row.id],
            log: { log: () => {} },
        });
        await vi.waitFor(() => expect(patches).toContainEqual(expect.objectContaining({
            sessionId: row.id,
            patch: expect.objectContaining({ agentStateVersion: 2, hasPendingPermissionRequests: true }),
        })));
    });
    it('preserves released responsibility omission without creating own-property undefined', async () => {
        const applySessionListRenderables = vi.fn();
        const legacy = buildSessionRow('legacy-omission') as Record<string, unknown>;
        delete legacy.viewer;
        delete legacy.responsibleAccountId;
        delete legacy.responsibleAccount;

        await fetchAndApplySessions({
            serverId: 'home-a',
            source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
            credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null,
            sessionDataKeys: new Map(),
            request: async () => jsonResponse({ sessions: [legacy], nextCursor: null, hasNext: false }),
            applySessions: vi.fn(),
            applySessionListRenderables,
            log: { log: () => {} },
        });

        const rendered = applySessionListRenderables.mock.calls[0]?.[0]?.[0] as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(rendered, 'responsibleAccountId')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(rendered, 'responsibleAccount')).toBe(false);
    });
    it('uses the query route for both row families and returns an unfinished attention frontier', async () => {
        const ordinaryCursor = encodeV2SessionListCursorV2({ sessionId: 'ordinary-before', meaningfulActivityAt: 3 });
        const attentionCursor = encodeV2SessionListCursorV2({ sessionId: 'attention-before', meaningfulActivityAt: 2 });
        const attentionNextCursor = encodeV2SessionListCursorV2({ sessionId: 'attention', meaningfulActivityAt: 1 });
        const request = vi.fn(async (path: string, init: RequestInit) => {
            expect(path).toBe('/v2/sessions/query');
            expect(init.method).toBe('POST');
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            if (body.attentionCursor === undefined) {
                expect(body).toEqual({ ...buildQuery(), cursor: ordinaryCursor, limit: 50 });
                return jsonResponse({
                    sessions: [buildSessionRow('ordinary')],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: attentionCursor,
                    attentionHasNext: true,
                });
            }
            expect(body).toEqual({ ...buildQuery(), attentionCursor, limit: 50 });
            return jsonResponse({
                sessions: [buildSessionRow('attention')],
                nextCursor: null,
                hasNext: false,
                attentionNextCursor,
                attentionHasNext: true,
            });
        });
        const applySessions = vi.fn();
        const applySessionListRenderables = vi.fn();

        const result = await fetchAndApplySessions({
            serverId: 'home-a',
            source: { kind: 'query', body: { ...buildQuery(), cursor: ordinaryCursor }, allowV1Fallback: false },
            sessionListAttentionMaxPages: 1,
            credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null,
            sessionDataKeys: new Map(),
            request,
            applySessions,
            applySessionListRenderables,
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            sessionIds: ['ordinary', 'attention'],
            nextCursor: null,
            hasNext: false,
            attentionNextCursor,
            attentionHasNext: true,
            current: true,
        });
        expect(applySessionListRenderables.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'ordinary', viewer: buildSessionRow('ordinary').viewer, hasUnreadMessages: false }),
        ]));
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('reports a superseded request as non-current so callers cannot publish its membership or cursors', async () => {
        let current = true;
        const applySessionListRenderables = vi.fn(() => {
            current = false;
        });

        const result = await fetchAndApplySessions({
            serverId: 'home-a',
            source: { kind: 'query', body: { ...buildQuery(), includeAttention: false }, allowV1Fallback: false },
            credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null,
            sessionDataKeys: new Map(),
            request: async () => jsonResponse({
                sessions: [buildSessionRow('late')],
                nextCursor: 'next-late',
                hasNext: true,
                attentionNextCursor: null,
                attentionHasNext: false,
            }),
            shouldContinue: () => current,
            applySessions: vi.fn(),
            applySessionListRenderables,
            log: { log: () => {} },
        });

        expect(result.current).toBe(false);
    });

    it('uses the attention page budget when resuming an already-open attention frontier', async () => {
        const request = vi.fn(async (_path: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            const cursor = String(body.attentionCursor);
            const page = Number(cursor.split('-')[1]);
            return jsonResponse({
                sessions: [buildSessionRow(`attention-${page}`)],
                nextCursor: null,
                hasNext: false,
                attentionNextCursor: page === 2 ? null : `attention-${page + 1}`,
                attentionHasNext: page !== 2,
            });
        });

        const result = await fetchAndApplySessions({
            serverId: 'home-a',
            source: { kind: 'query', body: buildQuery(), allowV1Fallback: false },
            sessionListAttentionCursor: 'attention-1',
            sessionListAttentionMaxPages: 2,
            credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption: null,
            sessionDataKeys: new Map(),
            request,
            applySessions: vi.fn(),
            applySessionListRenderables: vi.fn(),
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            sessionIds: ['attention-1', 'attention-2'],
            attentionNextCursor: null,
            attentionHasNext: false,
        });
    });
    it('DIAG187 FIX215 keeps answered query failures terminal during settling and recovers through normal Retry', async () => {
        let reply: 'refused' | 'miswired' | 'transport' | 'server_error' | 'valid' = 'refused';
        const row = { ...createPlainSessionCurrentProjectionRecordFixture({ id: 'diag187-query' }),
            viewer: createSessionViewerFixture() };
        const { latestFailureSeq: _latestFailureSeq, ...olderViewer } = row.viewer;
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: page => fetchAndApplySessions({
                serverId: 'home-a', source: page.source,
                credentials: { token: 'synthetic-token' }, accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
                encryption: null, sessionDataKeys: new Map(),
                request: async () => {
                    if (reply === 'transport') throw new TypeError('Failed to fetch');
                    if (reply === 'refused') return jsonResponse({ error: 'invalid_request' }, 400);
                    if (reply === 'server_error') return jsonResponse({ error: 'list_failed' }, 503);
                    return jsonResponse({ sessions: [{ ...row, viewer: reply === 'miswired' ? olderViewer : row.viewer }],
                        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
                },
                shouldContinue: () => !page.signal.aborted,
                applySessions: () => {}, applySessionListRenderables: () => {}, log: { log: () => {} },
            }),
        });
        const presentation = () => resolveSessionListQueryPresentation({
            selectedServerIds: ['home-a'], statesByServerId: { 'home-a': controller.getSnapshot() },
            coverageComplete: controller.getSnapshot().phase === 'ready', retainedRowCount: 0,
            settlingHomeServerId: 'home-a',
        });
        try {
            await controller.update({ query: buildQuery(), selected: true, online: true, supported: true });
            expect(controller.getSnapshot()).toMatchObject({ phase: 'error', failureReason: 'invalid_query',
                failedOperation: 'replace', appliedQueryKey: null, addresses: [] });
            reply = 'miswired';
            await controller.retry();
            expect(controller.getSnapshot()).toMatchObject({ phase: 'error', failureReason: 'response',
                failureCode: 'invalid_response', failedOperation: 'replace', appliedQueryKey: null, addresses: [] });
            expect(presentation()).toEqual({ kind: 'error', retainedRows: false });
            reply = 'transport';
            await controller.retry();
            expect(controller.getSnapshot()).toMatchObject({ phase: 'error', failureReason: 'network' });
            expect(presentation()).toEqual({ kind: 'initial_loading' });
            reply = 'server_error';
            await controller.retry();
            expect(controller.getSnapshot()).toMatchObject({ phase: 'error', failureReason: 'response', failureCode: null });
            expect(presentation()).toEqual({ kind: 'error', retainedRows: false });
            reply = 'valid';
            await controller.retry();
            expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', failureReason: null, failureCode: null,
                addresses: [{ serverId: 'home-a', sessionId: row.id }] });
            expect(controller.getSnapshot().appliedQueryKey).not.toBeNull();
            expect(presentation()).toEqual({ kind: 'ready', complete: true });
        } finally { controller.dispose(); }
    });

    it('revokes controller admission during HTTP and prevents real query ingestion or a later refresh', async () => {
        let finish!: (response: Response) => void;
        const request = vi.fn< (path: string, init: RequestInit) => Promise<Response> >(
            () => new Promise((resolve) => { finish = resolve; }),
        );
        const publishedIds: string[] = [];
        const controller = createSessionListQueryHomeController({
            serverId: 'home-a',
            fetchPage: (page) => fetchAndApplySessions({
                serverId: 'home-a',
                source: page.source,
                credentials: { token: 'token-a', encryption: { publicKey: 'public', machineKey: 'machine' } },
                accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
                encryption: null,
                sessionDataKeys: new Map(),
                request,
                shouldContinue: () => !page.signal.aborted,
                applySessions: (rows) => { publishedIds.push(...rows.map((row) => row.id)); },
                applySessionListRenderables: (rows) => { publishedIds.push(...rows.map((row) => row.id)); },
                log: { log: () => {} },
            }),
        });
        const input = { queryKey: 'a', query: buildQuery(), selected: true, online: true };
        const pending = controller.update({ ...input, supported: true });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
        const refresh = controller.refresh();
        await controller.update({ ...input, supported: false });
        finish(jsonResponse({
            sessions: [buildSessionRow('revoked')], nextCursor: null, hasNext: false,
            attentionNextCursor: null, attentionHasNext: false,
        }));
        await Promise.all([pending, refresh]);
        await controller.refresh();
        void controller.invalidate();
        await controller.loadNext();
        expect(publishedIds).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({ addresses: [], failureReason: 'unsupported' });
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[0]).toBe('/v2/sessions/query');
    });

});

describe('fetchAndApplySessions acquisition identity', () => {
    function buildHydrationEncryption() {
        return {
            decryptEncryptionKeys: async (values: readonly string[]) => values.map(() => null),
            initializeSessions: async () => null,
            removeSessionEncryption: () => {},
            getSessionEncryption: () => null,
        } as unknown as Parameters<typeof fetchAndApplySessions>[0]['encryption'];
    }

    it('does not cancel an in-flight ordinary read when a different ordinary corpus is read on the same Home', async () => {
        const encryption = buildHydrationEncryption();
        let releaseOrdinary!: () => void;
        const ordinaryReleased = new Promise<void>((resolve) => {
            releaseOrdinary = resolve;
        });

        const ordinary = fetchAndApplySessions({
            serverId: 'home-a',
            source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
            credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption,
            sessionDataKeys: new Map(),
            request: async () => {
                await ordinaryReleased;
                return jsonResponse({ sessions: [buildSessionRow('ordinary')], nextCursor: null, hasNext: false });
            },
            applySessions: vi.fn(),
            applySessionListRenderables: vi.fn(),
            log: { log: () => {} },
        });

        const archived = await fetchAndApplySessions({
            serverId: 'home-a',
            source: { kind: 'ordinary', path: '/v2/sessions/archived', allowV1Fallback: true },
            credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption,
            sessionDataKeys: new Map(),
            request: async () => jsonResponse({ sessions: [buildSessionRow('archived')], nextCursor: null, hasNext: false }),
            applySessions: vi.fn(),
            applySessionListRenderables: vi.fn(),
            log: { log: () => {} },
        });

        releaseOrdinary();
        const ordinaryResult = await ordinary;

        expect(archived.current).toBe(true);
        expect(ordinaryResult.current).toBe(true);
        expect(ordinaryResult.sessionIds).toEqual(['ordinary']);
    });

    it('does not publish an in-flight read that its owning caller supersedes', async () => {
        const encryption = buildHydrationEncryption();
        const firstAbort = new AbortController();
        const applyFirstSessions = vi.fn();
        const applyFirstRenderables = vi.fn();
        let releaseFirst!: () => void;
        const firstReleased = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = fetchAndApplySessions({
            serverId: 'home-a',
            signal: firstAbort.signal,
            source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
            credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
            accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
            encryption,
            sessionDataKeys: new Map(),
            request: async () => {
                await firstReleased;
                return jsonResponse({ sessions: [buildSessionRow('first')], nextCursor: null, hasNext: false });
            },
            applySessions: applyFirstSessions,
            applySessionListRenderables: applyFirstRenderables,
            log: { log: () => {} },
        });

        firstAbort.abort();
        try {
            const second = await fetchAndApplySessions({
                serverId: 'home-a',
                source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
                credentials: { token: 'token-a', secret: 'secret-a' } as AuthCredentials,
                accountCurrentness: PLAIN_ACCOUNT_CURRENTNESS,
                encryption,
                sessionDataKeys: new Map(),
                request: async () => jsonResponse({ sessions: [buildSessionRow('second')], nextCursor: null, hasNext: false }),
                applySessions: vi.fn(),
                applySessionListRenderables: vi.fn(),
                log: { log: () => {} },
            });

            releaseFirst();

            expect((await first).current).toBe(false);
            expect(second.current).toBe(true);
            expect(applyFirstSessions).not.toHaveBeenCalled();
            expect(applyFirstRenderables).not.toHaveBeenCalled();
        } finally {
            releaseFirst();
            await first.catch(() => undefined);
        }
    });
});
