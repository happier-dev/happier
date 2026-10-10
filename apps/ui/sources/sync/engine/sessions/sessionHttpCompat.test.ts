import { describe, expect, it, vi } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol';

import {
    fetchSessionListPageCompat,
    parseCompatSessionByIdResponse,
    scanSessionByIdFromCompatList,
} from './sessionHttpCompat';

/**
 * A populated layout-0 row with legacy object content, routed through coercion.
 * Optional current-only projections are not facts this legacy producer supplied.
 */
function buildFullyPopulatedLegacyRow() {
    return {
        id: 'session-full',
        seq: 42,
        createdAt: 1_699_000_000_000,
        updatedAt: 1_700_000_600_000,
        meaningfulActivityAt: 1_700_000_500_000,
        active: true,
        activeAt: 1_700_000_400_000,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: { path: '/repo/full' },
        metadataVersion: 7,
        metadataLayoutVersion: 0,
        agentState: { ready: true },
        agentStateVersion: 3,
        lastViewedSessionSeq: 4,
        unreadSince: 1_700_000_000_000,
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 2,
        pendingRequestObservedAt: 1_700_000_000_000,
        pendingCount: 5,
        pendingBlockedCount: 1,
        pendingVersion: 9,
        pendingActivationAuthorization: {
            status: 'waiting',
            requestId: 'activation-request-1',
            requestedAt: 1_700_000_000_100,
        },
        dataEncryptionKey: null,
        responsibleAccountId: 'account-responsible',
        responsibleAccount: {
            kind: 'account',
            accountId: 'account-responsible',
            firstName: 'Robin',
            lastName: null,
            username: 'robin',
            avatarUrl: null,
        },
        share: { accessLevel: 'edit', canApprovePermissions: true },
        latestTurnId: 'turn-9',
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 1_700_000_100_000,
        lastRuntimeIssue: null,
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 1_700_000_200_000,
        runtimeActivityRevision: 11,
        rollbackEligibleTurnStarts: [3, 8],
        latestReadyEventSeq: 41,
        latestReadyEventAt: 1_700_000_300_000,
        thinking: true,
        thinkingAt: 1_700_000_350_000,
        currentStorageState: 'server_partial',
        acceptedThroughServerSeq: 40,
        materializedThroughSourceAt: 1_700_000_250_000,
        publishedThroughServerSeq: 39,
        transcriptShareable: true,
    };
}

function coerceFullyPopulatedLegacyRow(): Record<string, unknown> {
    const parsed = parseCompatSessionByIdResponse({ session: buildFullyPopulatedLegacyRow() });
    expect(parsed).not.toBeNull();
    return parsed!.session as unknown as Record<string, unknown>;
}

describe('legacy session record coercion', () => {
    it('never downgrades a marked access projection into legacy owner authority', () => {
        expect(parseCompatSessionByIdResponse({
            session: {
                ...buildFullyPopulatedLegacyRow(),
                share: undefined,
                effectiveAccess: { v: 1, level: 'owner', capabilities: {} },
            },
        })).toBeNull();
    });
    it('rejects a malformed explicit viewer projection instead of coercing it to legacy shared read state', () => {
        const session = {
            ...buildLegacyCompatSession('viewer-session'),
            lastViewedSessionSeq: 2,
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: '2', unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
            },
        };

        expect(parseCompatSessionByIdResponse({ session })).toBeNull();
    });

    it('rejects an explicitly malformed encryption mode instead of treating it as a legacy omission', () => {
        expect(parseCompatSessionByIdResponse({
            session: {
                ...buildFullyPopulatedLegacyRow(),
                encryptionMode: 'encrypted-somehow',
                dataEncryptionKey: 'legacy-looking-envelope',
            },
        })).toBeNull();

        const withoutMode = buildFullyPopulatedLegacyRow();
        delete (withoutMode as { encryptionMode?: unknown }).encryptionMode;
        expect(parseCompatSessionByIdResponse({ session: withoutMode })).not.toBeNull();
    });

    it('preserves the supplied legacy record facts while normalizing object content', () => {
        const source = buildFullyPopulatedLegacyRow();
        const record = coerceFullyPopulatedLegacyRow();

        expect(record).toMatchObject({
            ...source,
            metadata: JSON.stringify(source.metadata),
            agentState: JSON.stringify(source.agentState),
        });
    });

    it('carries the attention edge facts the placement key depends on', () => {
        const record = coerceFullyPopulatedLegacyRow();

        // Dropping these silently degrades attention ordering onto `updatedAt`,
        // a key that moves on every message to an already-promoted session.
        expect(record.pendingRequestObservedAt).toBe(1_700_000_000_000);
        expect(record.latestReadyEventAt).toBe(1_700_000_300_000);
        expect(record.latestReadyEventSeq).toBe(41);
        expect(record.latestTurnId).toBe('turn-9');
        expect(record.thinking).toBe(true);
        expect(record.thinkingAt).toBe(1_700_000_350_000);
        expect(record.transcriptShareable).toBe(true);
        expect(record.pendingActivationAuthorization).toEqual({
            status: 'waiting',
            requestId: 'activation-request-1',
            requestedAt: 1_700_000_000_100,
        });
        expect(record.responsibleAccountId).toBe('account-responsible');
    });

    it('coerces absent or non-numeric edge facts to null rather than inventing a value', () => {
        const parsed = parseCompatSessionByIdResponse({
            session: {
                ...buildFullyPopulatedLegacyRow(),
                pendingRequestObservedAt: undefined,
                latestReadyEventAt: 'not-a-number',
                latestTurnId: 42,
            },
        });
        expect(parsed).not.toBeNull();
        const record = parsed!.session as unknown as Record<string, unknown>;

        expect(record.id).toBe('session-full');
        expect(record.pendingRequestObservedAt).toBeNull();
        expect(record.latestReadyEventAt).toBeNull();
        expect(record.latestTurnId).toBeNull();
    });
});

function buildLegacyCompatSession(id: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ path: `/repo/${id}` }),
        metadataVersion: 1,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        dataEncryptionKey: null,
        share: null,
    };
}

describe('scanSessionByIdFromCompatList', () => {
    it('falls back to /v1/sessions when older servers are missing both /v2 session routes', async () => {
        const request = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=200') {
                return new Response(JSON.stringify({
                    error: 'Not found',
                    path: '/v2/sessions',
                    method: 'GET',
                }), { status: 404 });
            }

            expect(path).toBe('/v1/sessions');
            return new Response(JSON.stringify({
                sessions: [buildLegacyCompatSession('older-session')],
            }), { status: 200 });
        });

        await expect(scanSessionByIdFromCompatList({
            request,
            token: 'token',
            sessionId: 'older-session',
        })).resolves.toEqual(expect.objectContaining({
            id: 'older-session',
        }));
    });

    it('fails a malformed marked-current page after one request without retrying v1', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            sessions: [{
                ...buildLegacyCompatSession('marked-malformed'),
                effectiveAccess: { v: 1, level: 'admin', capabilities: {} },
                responsibleAccountId: null,
                responsibleAccount: null,
            }],
            nextCursor: null,
            hasNext: false,
        }), { status: 200 }));

        await expect(scanSessionByIdFromCompatList({
            request,
            token: 'token',
            sessionId: 'marked-malformed',
        })).rejects.toMatchObject({ code: 'invalid_response' });
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe('fetchSessionListPageCompat query source', () => {
    it('posts the strict Home-local query and never falls back to the ordinary GET routes', async () => {
        const query = {
            v: 1,
            storage: 'active',
            includeInactive: false,
            scope: 'all_accessible',
            attention: 'any',
            audiences: [{ kind: 'team', teamId: 'team-a' }],
            tagIds: ['tag-a'],
        } satisfies SessionListQueryV1;
        const request = vi.fn(async () => new Response(JSON.stringify({
            error: 'Not found',
            errorCode: 'operation_not_supported',
        }), { status: 404 }));

        await expect(fetchSessionListPageCompat({
            request,
            token: 'home-a-token',
            source: { kind: 'query', body: query, allowV1Fallback: false },
            cursor: 'next-page',
            limit: 37,
        })).rejects.toMatchObject({
            status: 404,
            code: 'operation_not_supported',
        });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('/v2/sessions/query', {
            method: 'POST',
            headers: expect.objectContaining({
                Authorization: 'Bearer home-a-token',
                'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
                ...query,
                cursor: 'next-page',
                limit: 37,
            }),
        });
    });

    it.each([
        {
            name: 'mandatory attention continuation facts',
            response: {
                sessions: [],
                nextCursor: null,
                hasNext: false,
            },
        },
        {
            name: 'mandatory current access and viewer projections',
            response: {
                sessions: [buildLegacyCompatSession('legacy-shaped-query-row')],
                nextCursor: null,
                hasNext: false,
                attentionNextCursor: null,
                attentionHasNext: false,
            },
        },
    ])('rejects a successful current query response missing $name', async ({ response }) => {
        const request = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));

        await expect(fetchSessionListPageCompat({
            request,
            token: 'home-a-token',
            source: {
                kind: 'query',
                body: {
                    v: 1,
                    storage: 'active',
                    includeInactive: false,
                    scope: 'all_accessible',
                    attention: 'any',
                    audiences: [],
                    tagIds: [],
                },
                allowV1Fallback: false,
            },
            limit: 50,
        })).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('keeps ordinary GET compatibility and treats missing legacy attention fields as exhausted', async () => {
        const request = vi.fn(async (path: string) => {
            expect(path).toBe('/v2/sessions?limit=50');
            return new Response(JSON.stringify({
                sessions: [buildLegacyCompatSession('ordinary')],
                nextCursor: null,
                hasNext: false,
            }), { status: 200 });
        });

        await expect(fetchSessionListPageCompat({
            request,
            token: 'token',
            source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
            limit: 50,
        })).resolves.toMatchObject({
            source: 'v2',
            attentionNextCursor: null,
            attentionHasNext: false,
        });
    });
});
