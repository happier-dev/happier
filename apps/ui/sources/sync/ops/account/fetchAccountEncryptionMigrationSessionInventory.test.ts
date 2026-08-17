import { describe, expect, it, vi } from 'vitest';

import {
    fetchAccountEncryptionMigrationSessionInventory,
} from './fetchAccountEncryptionMigrationSessionInventory';

function buildSessionRow(params: Readonly<{
    id: string;
    layout?: 0 | 1;
    owner?: boolean;
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
        encryptionMode: 'plain',
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
            }),
        ).rejects.toThrow('pagination is incomplete');
    });

    it('fails locally when the owned layout-1 inventory exceeds 500 items', async () => {
        const request = vi.fn(async () => jsonResponse({
            sessions: Array.from(
                { length: 501 },
                (_, index) =>
                    buildSessionRow({ id: `session-${index}` }),
            ),
            hasNext: false,
            nextCursor: null,
        }));

        await expect(
            fetchAccountEncryptionMigrationSessionInventory({
                token: 'token',
                request,
            }),
        ).rejects.toThrow('exceeds the supported bound');
        expect(request).toHaveBeenCalledTimes(1);
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
            }),
        ).rejects.toThrow('Duplicate Session migration inventory row');
        expect(request).toHaveBeenCalledTimes(2);
    });
});
