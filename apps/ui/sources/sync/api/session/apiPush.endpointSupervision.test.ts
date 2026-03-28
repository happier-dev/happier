import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlMock(...args),
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            get currentState() {
                                return appState.currentState;
                            },
                        },
                    }
    );
});

describe('apiPush endpoint supervision', () => {
    afterEach(() => {
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        appState.currentState = 'active';
        vi.resetModules();
        vi.useRealTimers();
    });

    it('does not use raw global fetch when apiEndpoint is provided', async () => {
        const globalFetch = vi.fn(() => {
            throw new Error('raw global fetch should not be called');
        });
        (globalThis as unknown as { fetch?: unknown }).fetch = globalFetch as unknown;

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockImplementation(async (url: unknown) => {
            const asString = String(url ?? '');
            if (asString.endsWith('/v1/push-tokens')) {
                return new Response(JSON.stringify({ success: true }), { status: 200, headers: new Headers() });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
        });

        const { registerPushToken } = await import('./apiPush');

        await expect(
            registerPushToken(
                { token: 'token-1', secret: 'secret' },
                'push-token-1',
                { apiEndpoint: 'https://other.example.test', clientServerUrl: 'https://client.example.test' },
            ),
        ).resolves.toBeUndefined();

        expect(globalFetch).toHaveBeenCalledTimes(0);
        expect(runtimeFetchMock).toHaveBeenCalled();
    });

    it('uses the provided serverId when supervising an explicit apiEndpoint', async () => {
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token-1', secret: 'secret' });
        runtimeFetchMock.mockImplementation(async (url: unknown) => {
            const asString = String(url ?? '');
            if (asString.endsWith('/v1/push-tokens')) {
                return new Response(JSON.stringify({ success: true }), { status: 200, headers: new Headers() });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
        });

        const { registerPushToken } = await import('./apiPush');

        await expect(
            registerPushToken(
                { token: 'token-1', secret: 'secret' },
                'push-token-1',
                {
                    serverId: 'server-123',
                    apiEndpoint: 'https://other.example.test',
                    clientServerUrl: 'https://client.example.test',
                    retry: 'none',
                },
            ),
        ).resolves.toBeUndefined();

        const calls = getCredentialsForServerUrlMock.mock.calls as Array<[unknown, unknown]>;
        expect(
            calls.some((call) => {
                const options = call[1] as { serverId?: unknown } | undefined;
                return options?.serverId === 'server-123';
            }),
        ).toBe(true);
    });
});
