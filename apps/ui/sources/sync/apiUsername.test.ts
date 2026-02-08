import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';

vi.mock('@/utils/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/time')>();
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
    vi.doMock('./serverConfig', () => ({
        getServerUrl: () => 'https://api.example.test',
    }));
}

describe('setAccountUsername', () => {
    it('returns the username on success', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ username: 'alice' }),
        }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { setAccountUsername } = await import('./apiUsername');
        const res = await setAccountUsername(credentials, 'alice');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v1/account/username',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer t',
                    'Content-Type': 'application/json',
                }),
            }),
        );
        expect(res).toEqual({ username: 'alice' });
    });

    it('throws HappyError(username-taken) on 409 username-taken', async () => {
        mockServerConfig();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 409,
                json: async () => ({ error: 'username-taken' }),
            })) as unknown as typeof fetch,
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
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 400,
                json: async () => ({ error: 'invalid-username' }),
            })) as unknown as typeof fetch,
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
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 400,
                json: async () => ({ error: 'username-disabled' }),
            })) as unknown as typeof fetch,
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
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 400,
                json: async () => {
                    throw new Error('invalid json');
                },
            })) as unknown as typeof fetch,
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
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            })) as unknown as typeof fetch,
        );

        const { setAccountUsername } = await import('./apiUsername');
        await expect(setAccountUsername(credentials, 'alice')).rejects.toThrow('Failed to parse set username response');
    });
});
