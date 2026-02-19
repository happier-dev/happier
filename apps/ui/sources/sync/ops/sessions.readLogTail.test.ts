import { describe, expect, it, vi } from 'vitest';

type SessionReadLogTailRpcResponse =
    | Readonly<{ success: true; path: string; tail: string; truncated?: boolean }>
    | Readonly<{ success: false; error: string }>
    | null;

const sessionRPCSpy = vi.fn(
    async (_sessionId: string, _method: string, _payload: unknown): Promise<SessionReadLogTailRpcResponse> => ({
        success: true,
        path: '/tmp/happier/logs/session.log',
        tail: 'hello',
    }),
);

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

describe('sessionReadLogTail', () => {
    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { sessionReadLogTail } = await import('./sessions');

        sessionRPCSpy.mockResolvedValueOnce(null);

        const res = await sessionReadLogTail('s1');
        expect(res).toMatchObject({ success: false });
        expect(typeof res.error).toBe('string');
    });

    it('passes maxBytes to session.log.tail RPC', async () => {
        const { sessionReadLogTail } = await import('./sessions');

        await sessionReadLogTail('s1', { maxBytes: 32_000 });
        expect(sessionRPCSpy).toHaveBeenCalledWith('s1', 'session.log.tail', { maxBytes: 32_000 });
    });
});
