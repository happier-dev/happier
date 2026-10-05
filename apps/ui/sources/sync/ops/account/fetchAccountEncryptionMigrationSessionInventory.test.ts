import { describe, expect, it, vi } from 'vitest';

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

describe('fetchAccountEncryptionMigrationSessionInventory', () => {
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
            token: 'token', request, scope, onSession: (session) => modes.push(session),
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

        await expect(
            fetchAccountEncryptionMigrationSessionInventory({
                token: 'token',
                request,
                scope,
            }),
        ).resolves.toEqual([
            {
                id: 'active-owner',
                metadataLayoutVersion: 1,
                metadataVersion: 7,
                agentStateVersion: 8,
                ownerMetadata: { t: 'plain', v: { v: 1 } },
            },
            {
                id: 'archived-owner',
                metadataLayoutVersion: 1,
                metadataVersion: 7,
                agentStateVersion: 8,
                ownerMetadata: { t: 'plain', v: { v: 1 } },
            },
        ]);
        expect(request).toHaveBeenCalledTimes(3);
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
                request,
                scope,
            }),
        ).rejects.toThrow('repeated cursor');
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
                request,
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
            request,
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
                request,
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

        await expect(fetchAccountEncryptionMigrationSessionInventory({ token: 'token', request, scope }))
            .resolves.toEqual([]);
    });

    it('fails closed instead of using released owner fallback for malformed current access', async () => {
        const row = buildSessionRow({ id: 'malformed-current' });
        const request = vi.fn(async () => jsonResponse({
            sessions: [{ ...row, share: null, effectiveAccess: { v: 1, level: 'owner' } }],
            hasNext: false,
            nextCursor: null,
        }));

        await expect(fetchAccountEncryptionMigrationSessionInventory({ token: 'token', request, scope }))
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
            request,
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
