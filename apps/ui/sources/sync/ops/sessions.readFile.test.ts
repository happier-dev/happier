import { describe, expect, it, vi } from 'vitest';

const sessionRPCSpy = vi.fn(async () => ({ success: true, content: 'aGVsbG8=' }));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

describe('sessionReadFile', () => {
    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionReadFile } = await import('./sessions');

        sessionRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionReadFile('s1', 'src/a.ts');
        expect(res).toMatchObject({ success: false });
        expect(typeof res.error).toBe('string');
    });
});

