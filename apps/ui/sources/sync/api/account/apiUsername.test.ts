import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
        backoffForever: immediate,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockServerConfig() {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'test',
            serverUrl: 'https://api.example.test',
            kind: 'custom',
            generation: 1,
        }),
    }));
}

function resolveNonHealthCall(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string): RequestInit {
    const call = fetchMock.mock.calls.find(([input]) => String(input) === expectedUrl);
    const init = call?.[1];
    if (!init) {
        throw new Error(`Expected fetch call for ${expectedUrl}`);
    }
    return init;
}

describe('setAccountUsername', () => {
    it('returns the username on success', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ username: 'alice' }) };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { setAccountUsername } = await import('./apiUsername');
        const res = await setAccountUsername(credentials, 'alice');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v1/account/username',
            expect.objectContaining({
                method: 'POST',
                headers: expect.any(Headers),
            }),
        );
        const requestInit = resolveNonHealthCall(fetchMock, 'https://api.example.test/v1/account/username');
        expect((requestInit.headers as Headers).get('Authorization')).toBe('Bearer t');
        expect((requestInit.headers as Headers).get('Content-Type')).toBe('application/json');
        expect(res).toEqual({ username: 'alice' });
    });

    it('throws HappyError(username-taken) on 409 username-taken', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: false, status: 409, json: async () => ({ error: 'username-taken' }) };
        });
        vi.stubGlobal(
            'fetch',
            fetchMock as unknown as typeof fetch,
        );

        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'username-taken',
            status: 409,
        } satisfies Partial<HappyError>);
    });

    it('throws HappyError(invalid-username) on 400 invalid-username', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: false, status: 400, json: async () => ({ error: 'invalid-username' }) };
        });
        vi.stubGlobal(
            'fetch',
            fetchMock as unknown as typeof fetch,
        );

        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'bad')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'invalid-username',
            status: 400,
        } satisfies Partial<HappyError>);
    });

    it('maps username-disabled to config-kind HappyError', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: false, status: 400, json: async () => ({ error: 'username-disabled' }) };
        });
        vi.stubGlobal(
            'fetch',
            fetchMock as unknown as typeof fetch,
        );

        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'username-disabled',
            kind: 'config',
            status: 400,
        } satisfies Partial<HappyError>);
    });

    it('falls back to default 4xx message when error body is not JSON', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: false,
                status: 400,
                json: async () => {
                    throw new Error('invalid json');
                },
            };
        });
        vi.stubGlobal(
            'fetch',
            fetchMock as unknown as typeof fetch,
        );

        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toMatchObject({
            name: 'HappyError',
            message: 'Failed to set username',
            kind: 'server',
            status: 400,
        } satisfies Partial<HappyError>);
    });

    it('throws parse error when success payload does not include username', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        });
        vi.stubGlobal(
            'fetch',
            fetchMock as unknown as typeof fetch,
        );

        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toThrow('Failed to parse set username response');
    });
});
