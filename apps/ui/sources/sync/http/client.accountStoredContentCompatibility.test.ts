import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

describe('serverFetch account-stored-content compatibility', () => {
    afterEach(async () => {
        await resetServerReachabilitySupervisors();
        resetRuntimeFetch();
        vi.restoreAllMocks();
    });

    it('keeps the feature bootstrap header-free and advertises cumulative V4 before and after discovery', async () => {
        const runtimeFetch = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit,
        ) => new Response('{}', { status: 200 }));
        await upsertAndActivateServer({ serverUrl: 'https://server.example', name: 'Compatibility Home' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('compatibility-account') });
        setRuntimeFetch(runtimeFetch);

        const {
            recordAccountStoredContentServerRequirements,
            withAccountStoredContentCompatibilityRequestDeclaration,
        } = await import('./accountStoredContentCompatibility');
        const { serverFetch } = await import('./client');

        await serverFetch('/v2/account/settings', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-happier-account-stored-content-protocol': '3',
            },
            body: JSON.stringify({ content: null, expectedVersion: 0 }),
        }, { retry: 'none' });

        let init = runtimeFetch.mock.calls.at(-1)?.[1] ?? {};
        let headers = new Headers(init.headers);
        expect(headers.get('x-happier-account-stored-content-protocol')).toBe(
            String(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion),
        );

        await serverFetch('/v1/features', {
            headers: {
                'x-happier-account-stored-content-protocol': '3',
            },
        }, {
            includeAuth: false,
            retry: 'none',
        });

        init = runtimeFetch.mock.calls.at(-1)?.[1] ?? {};
        headers = new Headers(init.headers);
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
