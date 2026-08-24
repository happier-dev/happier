import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SessionDraftMutateResponseV1Schema,
    SessionDraftReadResponseV1Schema,
} from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({ serverFetch: vi.fn() }));
vi.mock('@/sync/http/client', () => ({ serverFetch: mocks.serverFetch }));

const credentials = { token: 'token-a', secret: 'secret-a' } as const;
const address = { kind: 'session', sessionId: 'session-a' } as const;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('apiSessionDrafts', () => {
    beforeEach(() => mocks.serverFetch.mockReset());

    it('posts typed read and mutate requests and validates responses', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const readResponse = SessionDraftReadResponseV1Schema.parse({ status: 'absent' });
        const mutateResponse = SessionDraftMutateResponseV1Schema.parse({
            status: 'conflict',
            current: { status: 'absent' },
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(readResponse)).mockResolvedValueOnce(jsonResponse(mutateResponse));
        const transport = createApiSessionDraftsTransport({ credentials });

        await expect(transport.read(address)).resolves.toEqual(readResponse);
        await expect(transport.mutate({ address, expectedRevision: 'absent', content: null })).resolves.toEqual(mutateResponse);

        expect(mocks.serverFetch).toHaveBeenNthCalledWith(1, '/v1/account/session-drafts/read', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ address }),
            headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
        }), { includeAuth: false });
    });

    it('rejects malformed successful responses instead of materializing unvalidated bytes', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ status: 'present', record: { revision: 'wrong' } }));

        await expect(createApiSessionDraftsTransport({ credentials }).read(address)).rejects.toThrow('Invalid session draft response');
    });
});
