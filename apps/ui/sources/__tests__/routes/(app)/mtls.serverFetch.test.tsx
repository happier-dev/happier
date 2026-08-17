import * as React from 'react';

import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import type {
    AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

const routerReplaceMock = vi.fn();
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: { replace: routerReplaceMock },
        params: { code: 'mtls-code' },
    }).module;
});

const modalAlertMock = vi.fn(async () => {});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: modalAlertMock },
    }).module;
});

const loginWithCredentialsMock = vi.fn<
    (...args: unknown[]) => Promise<AuthCredentialLifecycleResult>
>(async () => ({ kind: 'completed' }));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ loginWithCredentials: loginWithCredentialsMock }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://api.example.test', generation: 1 }),
}));

vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnv: () => '',
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
        getCredentialsForServerUrl: vi.fn(async () => null),
        invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

afterEach(async () => {
    try {
        const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        await stopAllEndpointSupervisorsForTests();
    } catch {
        // ignore
    }
    runtimeFetchMock.mockReset();
    modalAlertMock.mockClear();
    routerReplaceMock.mockClear();
    loginWithCredentialsMock.mockClear();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('MtlsCallbackScreen', () => {
    it('uses runtimeFetch via serverFetch (not global fetch) to claim the mtls token', async () => {
        const fetchMock = vi.fn(async () => {
            throw new Error('Unexpected global fetch call');
        });
        vi.stubGlobal('fetch', fetchMock as any);

        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
            if (url.includes('/health')) return okJson({ status: 'ok' });
            if (url.includes('/v1/auth/mtls/claim')) return okJson({ token: 'mtls-token' });
            return okJson({});
        });

        const { default: MtlsCallbackScreen } = await import('@/app/(app)/mtls');

        await act(async () => {
            await renderScreen(React.createElement(MtlsCallbackScreen));
        });

        await act(async () => {
            await new Promise<void>((resolve) => queueMicrotask(resolve));
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(loginWithCredentialsMock).toHaveBeenCalledWith({ token: 'mtls-token' });
        expect(routerReplaceMock).toHaveBeenCalledWith('/');
    });

    it('does not navigate as a successful mTLS replacement when credential recovery fails', async () => {
        loginWithCredentialsMock.mockResolvedValueOnce({
            kind: 'recovery_failed',
        });
        runtimeFetchMock.mockImplementation(async () => okJson({
            token: 'replacement-token',
        }));

        const { default: MtlsCallbackScreen } = await import('@/app/(app)/mtls');
        await act(async () => {
            await renderScreen(React.createElement(MtlsCallbackScreen));
        });
        await act(async () => {
            await new Promise<void>((resolve) => queueMicrotask(resolve));
        });

        expect(loginWithCredentialsMock).toHaveBeenCalledWith({
            token: 'replacement-token',
        });
        expect(routerReplaceMock).not.toHaveBeenCalled();
        expect(modalAlertMock).not.toHaveBeenCalled();
    });
});
