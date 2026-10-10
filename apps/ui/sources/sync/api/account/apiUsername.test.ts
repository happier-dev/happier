import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

async function activateTestHome() {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });
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
    it('does not retry the captured bearer against a successor Home after a transient failure', async () => {
        await activateTestHome();
        let observeIssued!: () => void;
        const issued = new Promise<void>((resolve) => { observeIssued = resolve; });
        let releaseFailure!: () => void;
        const failure = new Promise<void>((resolve) => { releaseFailure = resolve; });
        const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
            const url = new URL(String(input));
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({});
            if (url.origin === 'https://api.example.test') {
                observeIssued();
                await failure;
                return Response.json({}, { status: 503 });
            }
            return Response.json({ username: 'alice' });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        const { setAccountUsername } = await import('./apiUsername');
        const outcome = setAccountUsername(credentials, 'alice').then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
        await issued;
        vi.useFakeTimers();
        releaseFailure();
        await vi.advanceTimersByTimeAsync(0);
        const initial = resolveNonHealthCall(fetchMock, 'https://api.example.test/v1/account/username');
        expect(new Headers(initial.headers).get('authorization')).toBe('Bearer t');
        expect(JSON.parse(String(initial.body))).toEqual({ username: 'alice' });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://other.example.test' });
        await vi.advanceTimersByTimeAsync(1_000);
        const settled = await outcome;
        expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).origin === 'https://other.example.test')).toBe(false);
        expect(settled).toMatchObject({ status: 'rejected', reason: { name: 'StaleServerGenerationError' } });
    });

    it('returns the username on success', async () => {
        await activateTestHome();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (isServerFetchConnectivityProbeRequest(input)) {
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
        await activateTestHome();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (isServerFetchConnectivityProbeRequest(input)) {
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
        await activateTestHome();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (isServerFetchConnectivityProbeRequest(input)) {
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
        await activateTestHome();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (isServerFetchConnectivityProbeRequest(input)) {
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
        await activateTestHome();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (isServerFetchConnectivityProbeRequest(input)) {
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
        await activateTestHome();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (isServerFetchConnectivityProbeRequest(input)) {
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
