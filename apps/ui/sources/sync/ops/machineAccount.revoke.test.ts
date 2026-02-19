import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockServerFetch } = vi.hoisted(() => ({
    mockServerFetch: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: any[]) => mockServerFetch(...args),
}));

import { machineRevokeFromAccount } from './machineAccount';

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
    return {
        ok: opts.ok,
        status: opts.status ?? (opts.ok ? 200 : 500),
        json: async () => opts.json ?? {},
        text: async () => opts.text ?? '',
        headers: new Map(),
    } as any;
}

describe('machineRevokeFromAccount', () => {
    beforeEach(() => {
        mockServerFetch.mockReset();
    });

    it('posts to the revoke endpoint', async () => {
        mockServerFetch.mockResolvedValue(makeResponse({ ok: true }));

        await expect(machineRevokeFromAccount('m1')).resolves.toEqual({ ok: true });
        expect(mockServerFetch).toHaveBeenCalledWith(
            '/v1/machines/m1/revoke',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('returns a structured error when the server rejects the request', async () => {
        mockServerFetch.mockResolvedValue(makeResponse({ ok: false, status: 410, json: { error: 'machine_revoked' } }));

        await expect(machineRevokeFromAccount('m1')).resolves.toEqual({
            ok: false,
            status: 410,
            error: 'machine_revoked',
        });
    });
});

