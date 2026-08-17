import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('serverFetch account-stored-content compatibility', () => {
    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('keeps the feature bootstrap header-free, then advertises default V4 support after V3 base support is recorded', async () => {
        const runtimeFetch = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit,
        ) => new Response('{}', { status: 200 }));
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch,
            setRuntimeFetch: vi.fn(),
            resetRuntimeFetch: vi.fn(),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => ({ token: 'token' })),
                classifyPendingExternalAuthFirstKeyRejectedCredential:
                    vi.fn(async () => ({ kind: 'allowed' as const })),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            },
        }));
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server',
                serverUrl: 'https://server.example',
                generation: 1,
            }),
        }));
        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', () => ({
            peekServerReachabilityToken: () => null,
            reportServerUnreachable: vi.fn(),
            waitForServerReachable: vi.fn(async () => {}),
            ServerReachabilityWaitTimeoutError: class extends Error {},
        }));
        vi.doMock('@/sync/runtime/connectivity/endpointSupervisorPool', () => ({
            getEndpointSupervisorForServer: () => null,
        }));

        const {
            recordAccountStoredContentServerRequirements,
            withAccountStoredContentCompatibilityRequestDeclaration,
        } = await import('./accountStoredContentCompatibility');
        const { serverFetch } = await import('./client');
        await serverFetch('/v1/features', {
            headers: {
                'x-happier-account-stored-content-protocol': '3',
            },
        }, {
            includeAuth: false,
            retry: 'none',
        });

        let init = runtimeFetch.mock.calls.at(-1)?.[1] ?? {};
        let headers = new Headers(init.headers);
        expect(headers.has('x-happier-account-stored-content-protocol')).toBe(false);

        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://server.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
        await serverFetch('/v1/machines', {
            headers: { 'x-caller-header': 'kept' },
        }, { retry: 'none' });

        init = runtimeFetch.mock.calls.at(-1)?.[1] ?? {};
        headers = new Headers(init.headers);
        expect(headers.get('x-happier-account-stored-content-protocol')).toBe(
            String(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion),
        );
        expect(headers.get('x-caller-header')).toBe('kept');

        await serverFetch('/v1/plugins/data/ui-query',
            withAccountStoredContentCompatibilityRequestDeclaration({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            }, PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            { includeAuth: false, retry: 'none' },
        );

        init = runtimeFetch.mock.calls.at(-1)?.[1] ?? {};
        headers = new Headers(init.headers);
        expect(headers.get('x-happier-account-stored-content-protocol')).toBe('3');
    });
});
