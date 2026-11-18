import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { completeAccountServicePostAuth, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { cancelPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { ENROLLMENT_POLL_IDLE_DELAY_MS } from '@/auth/enrollment/enrollmentPollingBackoff';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (options: { endpointUrl: string }) => (path: string, init?: RequestInit) => boundary.request(options.endpointUrl, path, init),
    serverFetch: (path: string, init?: RequestInit) => boundary.request('ambient', path, init),
}));
const navigation = vi.hoisted(() => ({ params: {} as Record<string, string>, replace: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => navigation.params, router: { replace: navigation.replace } }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

import { AuthProvider } from '@/auth/context/AuthContext';
import OAuthReturn from '@/app/(app)/oauth/[provider]';

describe('Account Directory callback route contraction', () => {
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let restore: () => void;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    beforeEach(async () => {
        restore = installLocalStorageMock().restore;
        fixture = createDirectoryHttpFixture();
        boundary.request.mockImplementation(fixture.request);
        navigation.replace.mockClear();
        navigation.params = { provider: 'github', flow: 'auth', purpose: 'account_directory', credentialTarget: 'account_directory',
            endpointUrl: fixture.service.endpointUrl, endpointServerIdentityId: fixture.service.serverIdentityId,
            canonicalServerUrl: fixture.service.canonicalServerUrl, pending: 'server-pending', mode: 'keyless' };
        await TokenStorage.setPendingAccountDirectoryAuth({
            endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId,
            canonicalServerUrl: fixture.service.canonicalServerUrl, purpose: 'account_directory', credentialTarget: 'account_directory',
            provider: 'github', mode: 'keyless', proof: 'bound-proof', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } }, returnTo: '/setup/wizard',
        });
    });
    afterEach(async () => { await screen?.unmount(); screen = undefined; restore(); });

    it('returns to recorded invocation after restricted commit without running Home continuation', async () => {
        screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthReturn /></AuthProvider>);
        await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/setup/wizard', params: expect.objectContaining({ accountServiceReturn: '1' }),
        })));
        expect(fixture.state.calls.map(({ path }) => path)).toEqual(['/v1/features', '/v1/auth/external/github/finalize-keyless']);
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })).toEqual({ token: fixture.directoryToken });
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
    });

    it('selects exact callback custody when the same provider has another pending service journey', async () => {
        await TokenStorage.setPendingAccountDirectoryAuth({
            endpoint: 'https://accounts-other.example.test', serverIdentityId: 'srv_accounts_other',
            canonicalServerUrl: 'https://accounts-other.example.test', purpose: 'account_directory', credentialTarget: 'account_directory',
            provider: 'github', mode: 'keyless', proof: 'other-proof', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
            entryIntent: { kind: 'refresh' }, returnTo: '/settings/account',
        });

        screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthReturn /></AuthProvider>);

        await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/setup/wizard', params: expect.objectContaining({ accountServiceReturn: '1' }),
        })));
        expect(fixture.state.calls.map(({ path }) => path)).toEqual(['/v1/features', '/v1/auth/external/github/finalize-keyless']);
    });

    it('renders the Home-named refusal it classified instead of one generic failure', async () => {
        fixture.state.exchangeStatus = 403;
        fixture.state.exchangeError = 'account-disabled';

        screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthReturn /></AuthProvider>);

        await vi.waitFor(() => expect(screen!.findByTestId('oauth-account-directory-failure')).toBeTruthy());
        expect(screen.getTextContent()).toContain('This account is disabled');
        expect(screen.getTextContent()).not.toContain('Operation failed');
        expect(navigation.replace).not.toHaveBeenCalled();
    });

    it('rejects callback identity tampering without issuing a restricted credential', async () => {
        navigation.params.endpointServerIdentityId = 'srv_attacker';
        screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthReturn /></AuthProvider>);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        expect(fixture.state.calls).toEqual([]);
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })).toBeNull();
        expect(navigation.replace).not.toHaveBeenCalled();
    });
});
