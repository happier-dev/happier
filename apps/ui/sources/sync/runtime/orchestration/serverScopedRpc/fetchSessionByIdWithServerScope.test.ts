import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveContextSpy = vi.hoisted(() => vi.fn());
const fetchAndApplySessionByIdSpy = vi.hoisted(() => vi.fn());
const runtimeFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('./resolveServerScopedSessionContext', () => ({
    resolveServerScopedSessionContext: (params: unknown) => resolveContextSpy(params),
}));

vi.mock('@/sync/engine/sessions/sessionById', () => ({
    fetchAndApplySessionById: (params: unknown) => fetchAndApplySessionByIdSpy(params),
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
}));

describe('fetchSessionByIdWithServerScope', () => {
    afterEach(() => {
        resolveContextSpy.mockReset();
        fetchAndApplySessionByIdSpy.mockReset();
        runtimeFetchSpy.mockReset();
    });

    it('uses the active session-by-id request when the preferred owner server is active', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        fetchAndApplySessionByIdSpy.mockResolvedValue({ ok: true, session: { id: 'session-1' } });
        const activeRequest = vi.fn(async () => new Response(null, { status: 200 }));

        const { fetchSessionByIdWithServerScope } = await import('./fetchSessionByIdWithServerScope');

        const result = await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            serverId: 'server-a',
            activeCredentials: { token: 'active-token', secret: 'active-secret' },
            activeEncryption: {} as any,
            sessionDataKeys: new Map<string, Uint8Array>(),
            activeRequest,
            applySessions: vi.fn(),
            log: { log: vi.fn() },
        });

        expect(result).toEqual({ ok: true, session: { id: 'session-1' } });
        expect(resolveContextSpy).toHaveBeenCalledWith({ serverId: 'server-a' });
        expect(fetchAndApplySessionByIdSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            credentials: { token: 'active-token', secret: 'active-secret' },
            request: activeRequest,
        }));
        expect(runtimeFetchSpy).not.toHaveBeenCalled();
    });

    it('uses a scoped session-by-id request when the preferred owner server differs from active', async () => {
        const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1]));
        const initializeSessions = vi.fn(async () => {});
        const getSessionEncryption = vi.fn(() => ({
            decryptAgentState: vi.fn(async () => null),
            decryptMetadata: vi.fn(async () => null),
        }));
        resolveContextSpy.mockResolvedValue({
            scope: 'scoped',
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'scoped-token',
            timeoutMs: 5000,
            encryption: {
                decryptEncryptionKey,
                initializeSessions,
                getSessionEncryption,
            },
        });
        fetchAndApplySessionByIdSpy.mockResolvedValue({ ok: true, session: { id: 'session-1' } });
        runtimeFetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

        const { fetchSessionByIdWithServerScope } = await import('./fetchSessionByIdWithServerScope');

        const result = await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            serverId: 'server-b',
            activeCredentials: { token: 'active-token', secret: 'active-secret' },
            activeEncryption: {} as any,
            sessionDataKeys: new Map<string, Uint8Array>(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
        });

        expect(result).toEqual({ ok: true, session: { id: 'session-1' } });
        const params = fetchAndApplySessionByIdSpy.mock.calls[0]?.[0];
        expect(params.credentials).toEqual({ token: 'scoped-token', secret: '' });
        await params.request('/v2/sessions/session-1', { method: 'GET', headers: { 'X-Test': '1' } });
        expect(runtimeFetchSpy).toHaveBeenCalledWith(
            'https://server-b.example.test/v2/sessions/session-1',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer scoped-token',
                    'X-Test': '1',
                }),
            }),
        );
    });

    it('forwards shell-only hydration options to the session-by-id reader', async () => {
        resolveContextSpy.mockResolvedValue({ scope: 'active', timeoutMs: 5000 });
        fetchAndApplySessionByIdSpy.mockResolvedValue({ ok: true, session: { id: 'session-1' } });

        const { fetchSessionByIdWithServerScope } = await import('./fetchSessionByIdWithServerScope');

        await fetchSessionByIdWithServerScope({
            sessionId: 'session-1',
            serverId: 'server-a',
            activeCredentials: { token: 'active-token', secret: 'active-secret' },
            activeEncryption: {} as any,
            sessionDataKeys: new Map<string, Uint8Array>(),
            activeRequest: vi.fn(),
            applySessions: vi.fn(),
            log: { log: vi.fn() },
            includeTurnsProjection: false,
        });

        expect(fetchAndApplySessionByIdSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            includeTurnsProjection: false,
        }));
    });
});
