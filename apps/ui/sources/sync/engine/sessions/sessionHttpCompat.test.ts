import { describe, expect, it, vi } from 'vitest';

import { scanSessionByIdFromCompatList } from './sessionHttpCompat';

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
});
