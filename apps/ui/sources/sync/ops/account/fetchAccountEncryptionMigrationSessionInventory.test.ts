import { describe, expect, it, vi } from 'vitest';
import { createCompactSessionListFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { projectSessionDisplayV1, sealSessionSharedDisplayEnvelopeV1Sync } from '@happier-dev/protocol/sessions';

import {
    fetchAccountEncryptionMigrationSessionInventory,
} from './fetchAccountEncryptionMigrationSessionInventory';

const scope = {
    scope: { serverId: 'home-a', accountId: 'account-a' },
    isCurrent: () => true,
};

function buildSessionRow(params: Readonly<{
    id: string;
    layout?: 0 | 1;
    owner?: boolean;
    encryptionMode?: 'plain' | 'e2ee';
}>) {
    const layout = params.layout ?? 1;
    const owner = params.owner ?? true;
    return {
        id: params.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        encryptionMode: params.encryptionMode ?? 'plain',
        metadata: 'shared-metadata',
        metadataVersion: 7,
        ...(layout === 1
            ? {
                metadataLayoutVersion: 1,
                ...(owner
                    ? { ownerMetadata: { t: 'plain', v: { v: 1 } } }
                    : {}),
                agentState: owner ? 'owner-agent-state' : null,
                agentStateVersion: 8,
            }
            : {
                agentState: 'legacy-agent-state',
                agentStateVersion: 8,
            }),
        dataEncryptionKey: null,
        share: owner
            ? null
            : {
                accessLevel: 'view',
                canApprovePermissions: false,
            },
    };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function requestListSources(request: Parameters<typeof fetchAccountEncryptionMigrationSessionInventory>[0]['request']) {
    return createCompactSessionListFetchBoundary(async (path, init) => {
        if (path === '/v2/sessions/read-batch') return undefined;
        return request(path, init);
    });
}

describe('fetchAccountEncryptionMigrationSessionInventory', () => {
    it('carries the exact full-read display sidecar into the owner Account transition inventory', async () => {
        const shared = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain',
            display: projectSessionDisplayV1({ sharedMetadata: { v: 1 } }).shared });
        if (!shared.ok) throw new Error('Expected canonical shared display fixture');
        const displayProjectionV1 = { v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: 7,
            shared: shared.envelope };
        const row = { ...buildSessionRow({ id: 'retained-display' }), displayProjectionV1 };
        const rows = await fetchAccountEncryptionMigrationSessionInventory({ token: 'token', scope,
            request: requestListSources(async path => jsonResponse({ sessions: path.startsWith('/v2/sessions/archived') ? [] : [row],
                hasNext: false, nextCursor: null })),
        });
        expect(rows[0]).toMatchObject({ encryptionMode: 'plain', displayProjectionV1 });
    });

    it('normalizes stored Bot owner extensions while preserving the canonical migration precondition', async () => {
        const row = { ...buildSessionRow({ id: 'bot' }), ownerMetadata: {
            t: 'plain', future: true, v: { v: 1, future: true,
                work: { bot: { kind: 'bot', future: true }, createdAsBot: true,
                    viewPreferences: { showToolCalls: false, future: true }, future: true } },
        } };
        const rows = await fetchAccountEncryptionMigrationSessionInventory({ token: 'token', scope,
            request: requestListSources(async (path) => jsonResponse({ sessions: path.startsWith('/v2/sessions/archived') ? [] : [row],
                hasNext: false, nextCursor: null })),
        });
        expect(rows[0]?.ownerMetadata).toEqual({ t: 'plain', v: { v: 1, work: {
            bot: { kind: 'bot' }, createdAsBot: true, viewPreferences: { showToolCalls: false },
        } } });
    });
    it('observes retained Session modes before layout and ownership filtering, including archived Sessions', async () => {
        const modes: Array<Readonly<{ sessionId: string; encryptionMode: 'plain' | 'e2ee' }>> = [];
        const request = async (path: string) => jsonResponse({
            sessions: path.startsWith('/v2/sessions/archived')
                ? [buildSessionRow({ id: 'archived-encrypted', layout: 0, encryptionMode: 'e2ee' })]
                : [buildSessionRow({ id: 'plain-owner' }),
                    buildSessionRow({ id: 'encrypted-recipient', layout: 0, owner: false, encryptionMode: 'e2ee' })],
            hasNext: false, nextCursor: null,
        });

        const migrationRows = await fetchAccountEncryptionMigrationSessionInventory({
            token: 'token', request: requestListSources(request), scope, onSession: (session) => modes.push(session),
        });

        expect(migrationRows.map((row) => row.id)).toEqual(['plain-owner']);
        expect(modes).toEqual([
            { sessionId: 'plain-owner', encryptionMode: 'plain' },
            { sessionId: 'encrypted-recipient', encryptionMode: 'e2ee' },
            { sessionId: 'archived-encrypted', encryptionMode: 'e2ee' },
        ]);
    });
    it('exhausts active and archived pages and keeps only owned layout-1 rows', async () => {
        const request = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=200') {
                return jsonResponse({
                    sessions: [
                        buildSessionRow({ id: 'active-owner' }),
                        buildSessionRow({
                            id: 'active-recipient',
                            owner: false,
                        }),
                    ],
                    hasNext: true,
                    nextCursor: 'active-next',
                });
            }
            if (
                path
                === '/v2/sessions?limit=200&cursor=active-next'
            ) {
                return jsonResponse({
                    sessions: [
                        buildSessionRow({
                            id: 'active-layout-zero',
                            layout: 0,
                        }),
                    ],
                    hasNext: false,
                    nextCursor: null,
                });
            }
            if (path === '/v2/sessions/archived?limit=200') {
                return jsonResponse({
                    sessions: [
                        buildSessionRow({ id: 'archived-owner' }),
                    ],
                    hasNext: false,
                    nextCursor: null,
                });
            }
            throw new Error(`Unexpected request path: ${path}`);
        });

        const boundary = vi.fn(requestListSources(request));
        await expect(
            fetchAccountEncryptionMigrationSessionInventory({
                token: 'token',
                request: boundary,
                scope,
            }),
        ).resolves.toEqual([
            {
                id: 'active-owner',
                encryptionMode: 'plain',
                displayProjectionV1: null,
                metadataLayoutVersion: 1,
                metadataVersion: 7,
                agentStateVersion: 8,
                ownerMetadata: { t: 'plain', v: { v: 1 } },
            },
            {
                id: 'archived-owner',
                encryptionMode: 'plain',
                displayProjectionV1: null,
                metadataLayoutVersion: 1,
                metadataVersion: 7,
                agentStateVersion: 8,
                ownerMetadata: { t: 'plain', v: { v: 1 } },
            },
        ]);
        expect(request).toHaveBeenCalledTimes(3);
        const batchReads = boundary.mock.calls.filter(([path]) => path === '/v2/sessions/read-batch');
        expect(batchReads).toHaveLength(1);
        const batchInit = batchReads[0]?.[1];
        if (typeof batchInit?.body !== 'string') throw new Error('Expected a JSON snapshot batch request body');
        expect(JSON.parse(batchInit.body)).toEqual({
            sessionIds: ['active-owner', 'archived-owner'], includeSnapshot: true,
            includeTurns: false, includeMessages: false,
        });
    });

    it('fails closed when pagination repeats a cursor', async () => {
        const request = vi.fn(async (path: string) => {
            if (path === '/v2/sessions?limit=200') {
                return jsonResponse({
                    sessions: [],
                    hasNext: true,
                    nextCursor: 'repeat',
                });
            }
            return jsonResponse({
                sessions: [],
                hasNext: true,
                nextCursor: 'repeat',
            });
        });

        await expect(
            fetchAccountEncryptionMigrationSessionInventory({
                token: 'token',
                request: requestListSources(request),
                scope,
            }),
        ).rejects.toThrow('repeated cursor');
    });

    it.each([403, 409, 503] as const)('preserves a per-Session batch refusal (%s) instead of returning a partial inventory', async status => {
        const request = createCompactSessionListFetchBoundary(async (path) => {
            if (path === '/v2/sessions/read-batch') return jsonResponse({ results: [{ sessionId: 'owner',
                detail: { status, body: { error: 'unavailable', code: 'session_inventory_unavailable' } } }] });
            return jsonResponse({ sessions: path.startsWith('/v2/sessions/archived') ? [] : [buildSessionRow({ id: 'owner' })],
                hasNext: false, nextCursor: null });
        });
        await expect(fetchAccountEncryptionMigrationSessionInventory({ token: 'token', scope, request }))
            .rejects.toMatchObject({ httpStatus: status, body: { code: 'session_inventory_unavailable' } });
    });

    it('fails closed when owner access is revoked between the census and full snapshot', async () => {
        const request = createCompactSessionListFetchBoundary(async (path) => {
            if (path === '/v2/sessions/read-batch') return jsonResponse({ results: [{ sessionId: 'owner',
                detail: { status: 200, body: { session: buildSessionRow({ id: 'owner', owner: false }) } } }] });
            return jsonResponse({ sessions: path.startsWith('/v2/sessions/archived') ? [] : [buildSessionRow({ id: 'owner' })],
                hasNext: false, nextCursor: null });
        });
        await expect(fetchAccountEncryptionMigrationSessionInventory({ token: 'token', scope, request }))
            .rejects.toMatchObject({ name: 'Error', message: 'Invalid Session batch response' });
    });

    it('fails closed when a continuing page omits its cursor', async () => {
        const request = vi.fn(async () => jsonResponse({
            sessions: [],
            hasNext: true,
            nextCursor: null,
        }));

        await expect(
            fetchAccountEncryptionMigrationSessionInventory({
                token: 'token',
                request: requestListSources(request),
                scope,
            }),
        ).rejects.toThrow('pagination is incomplete');
    });

    it('returns a complete owner inventory beyond the former 500-item ceiling', async () => {
        const request = vi.fn(async (path: string) => jsonResponse({
            sessions: path.startsWith('/v2/sessions/archived')
                ? []
                : Array.from(
                    { length: 501 },
                    (_, index) =>
                        buildSessionRow({ id: `session-${index}` }),
                ),
            hasNext: false,
            nextCursor: null,
        }));

        await expect(fetchAccountEncryptionMigrationSessionInventory({
            token: 'token',
            request: requestListSources(request),
            scope,
        })).resolves.toHaveLength(501);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('fails closed on a duplicate Session across active and archived inventory', async () => {
        const request = vi.fn(async (path: string) => jsonResponse({
            sessions: [buildSessionRow({ id: 'duplicate' })],
            hasNext: false,
            nextCursor: null,
        }));

        await expect(
            fetchAccountEncryptionMigrationSessionInventory({
                token: 'token',
                request: requestListSources(request),
                scope,
            }),
        ).rejects.toThrow('Duplicate Session migration inventory row');
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('skips a current Team recipient whose released shape has no direct share', async () => {
        const row = buildSessionRow({ id: 'team-recipient', owner: false });
        const { share: _releasedShare, ...teamRecipientRow } = row;
        const request = vi.fn(async (path: string) => jsonResponse({
            sessions: path.startsWith('/v2/sessions/archived') ? [] : [{
                ...teamRecipientRow,
                effectiveAccess: {
                    v: 1,
                    level: 'view',
                    sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
                    capabilities: {
                        readTranscript: true,
                        submitAgentInput: false,
                        editSessionRecords: false,
                        approveRuntimePermissions: false,
                        manageAccess: false,
                        managePermissionDelegation: false,
                        managePublicLink: false,
                        archiveSession: false,
                        renameSession: false,
                        assignResponsibility: false,
                        stopSession: false,
                        deleteSession: false,
                    },
                    audienceContext: { kind: 'team', teamId: 'team-1' },
                    primaryTeamId: 'team-1',
                },
            }],
            hasNext: false,
            nextCursor: null,
        }));

        await expect(fetchAccountEncryptionMigrationSessionInventory({ token: 'token', request: requestListSources(request), scope }))
            .resolves.toEqual([]);
    });

    it('fails closed instead of using released owner fallback for malformed current access', async () => {
        const row = buildSessionRow({ id: 'malformed-current' });
        const request = vi.fn(async () => jsonResponse({
            sessions: [{ ...row, share: null, effectiveAccess: { v: 1, level: 'owner' } }],
            hasNext: false,
            nextCursor: null,
        }));

        await expect(fetchAccountEncryptionMigrationSessionInventory({ token: 'token', request: requestListSources(request), scope }))
            .rejects.toThrow();
    });

    it('fails closed when the captured Home/Account scope retires during a page', async () => {
        let releasePage!: () => void;
        const pageReleased = new Promise<void>((resolve) => { releasePage = resolve; });
        let current = true;
        const request = vi.fn(async () => {
            await pageReleased;
            return jsonResponse({
                sessions: [buildSessionRow({ id: 'stale-owner' })],
                hasNext: false,
                nextCursor: null,
            });
        });
        const pending = fetchAccountEncryptionMigrationSessionInventory({
            token: 'token',
            request: requestListSources(request),
            scope: {
                scope: { serverId: 'home-a', accountId: 'account-a' },
                isCurrent: () => current,
            },
        });

        current = false;
        releasePage();
        await expect(pending).rejects.toThrow('Account Settings request scope changed');
    });
});
