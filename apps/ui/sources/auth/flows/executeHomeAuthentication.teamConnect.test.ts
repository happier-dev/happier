import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { executeHomeAuthentication } from './executeHomeAuthentication';

// Network, the OS URL opener and the person-facing alert are the boundaries; TokenStorage,
// the github provider, the first-key guard and key generation stay real.
const boundary = vi.hoisted(() => ({
    request: vi.fn<RuntimeFetch>(),
    openUrl: vi.fn<(url: string) => Promise<void>>(),
    alert: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeNativeMock({ platformOS: 'ios' }, {
        Linking: { openURL: boundary.openUrl },
    });
});
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: boundary.request ,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ spies: { alert: boundary.alert } }).module);

/**
 * Each test gets its own Home: TokenStorage keeps a process-local credential read cache
 * across tests in one module instance, and a distinct Home identity keeps them independent.
 */
function teamHome(name: string) {
    const target = {
        kind: 'descriptor' as const,
        authority: 'trusted_enrollment' as const,
        descriptor: {
            v: 1 as const,
            homeServerIdentityId: `home-${name}`,
            canonicalServerUrl: `https://${name}.example.test`,
            revision: 1,
            endpoints: [{ kind: 'https' as const, url: `https://edge-${name}.example.test` }],
        },
    };
    const request = {
        method: { id: 'github', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
        action: { id: 'provision', mode: 'keyed' },
        execution: { kind: 'oauth' as const, providerId: 'github', mode: 'keyed' as const },
        authority: { purpose: 'home' as const, target },
        intendedHome: target,
    } satisfies WelcomeAuthenticationMethod;
    return {
        request,
        returnTo: `/teams/team-1/sign-in?target=home-${name}`,
        endpoint: `https://edge-${name}.example.test`,
        credentialTarget: { serverUrl: `https://${name}.example.test`, serverId: `home-${name}` },
    };
}

function requests(): Array<Readonly<{ url: URL; init: RequestInit | undefined }>> {
    return boundary.request.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), init }));
}

describe('executeHomeAuthentication Team admission for a signed-in Account', () => {
    beforeEach(() => {
        boundary.request.mockReset();
        boundary.openUrl.mockReset();
        boundary.alert.mockReset();
        boundary.openUrl.mockResolvedValue(undefined);
        boundary.request.mockImplementation(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/connect/external/github/params') return Response.json({
                url: 'https://github.example.test/authorize?state=connect',
                purpose: 'team_admission', teamId: 'team-1', admissionReference: 'connect-attempt-1',
            });
            if (url.pathname === '/v1/auth/external/github/params') return Response.json({
                url: 'https://github.example.test/authorize?state=provision',
                purpose: 'team_admission', teamId: 'team-1', admissionReference: 'provision-attempt-1',
            });
            return new Response('{}', { status: 404 });
        });
    });

    it('links the Team identity to the Account this device already holds instead of minting a keypair', async () => {
        const { request, returnTo, endpoint, credentialTarget } = teamHome('signed-in');
        expect(await TokenStorage.setCredentialsForServerUrl(
            credentialTarget.serverUrl, { serverId: credentialTarget.serverId }, { token: 'existing-account-token' },
        )).toBe(true);
        const onExternalAuthStarted = vi.fn();

        await executeHomeAuthentication({
            request,
            loginWithCredentials: vi.fn(),
            returnTo,
            teamAdmission: { teamId: 'team-1', origin: 'team' },
            onAuthenticated: vi.fn(),
            onExternalAuthStarted,
        });

        expect(boundary.alert).not.toHaveBeenCalled();
        // One authenticated connect start at the exact Home, proven by the saved bearer;
        // the provisioning start (whose fresh seed would become a new Account) never runs.
        expect(requests().map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
            `${endpoint}/v1/connect/external/github/params`,
        ]);
        const [connect] = requests();
        expect(Object.fromEntries(connect!.url.searchParams)).toEqual({ purpose: 'team_admission', teamId: 'team-1', origin: 'team' });
        expect(new Headers(connect!.init?.headers).get('Authorization')).toBe('Bearer existing-account-token');
        // The continuation is bound to the exact Home whose credential started it,
        // never to whichever Home happens to be focused when the browser returns.
        expect(await TokenStorage.getPendingExternalConnect()).toEqual({ provider: 'github', returnTo, ...credentialTarget });
        expect((await TokenStorage.readPendingExternalAuthState()).value).toBeNull();
        expect(boundary.openUrl).toHaveBeenCalledWith('https://github.example.test/authorize?state=connect');
        expect(onExternalAuthStarted).toHaveBeenCalledTimes(1);
    });

    it('keeps the provisioning start for a device with no credential on that Home', async () => {
        const { request, returnTo, endpoint, credentialTarget } = teamHome('new-device');
        await executeHomeAuthentication({
            request,
            loginWithCredentials: vi.fn(),
            returnTo,
            teamAdmission: { teamId: 'team-1', origin: 'team' },
            onAuthenticated: vi.fn(),
        });

        expect(boundary.alert).not.toHaveBeenCalled();
        expect(requests().map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
            `${endpoint}/v1/auth/external/github/params`,
        ]);
        const [start] = requests();
        // The keyed start carries a freshly minted public key for the new Account.
        expect(start!.url.searchParams.get('publicKey')).toEqual(expect.any(String));
        expect(start!.url.searchParams.get('proofHash')).toMatch(/^[a-f0-9]{64}$/);
        expect(start!.url.searchParams.get('teamId')).toBe('team-1');
        expect(await TokenStorage.getPendingExternalConnect()).toBeNull();
        const pending = (await TokenStorage.readPendingExternalAuthStateForServerUrl(
            endpoint, { serverId: credentialTarget.serverId },
        )).value;
        expect(pending).toMatchObject({
            provider: 'github',
            secret: expect.any(String),
            teamContinuation: {
                purpose: 'team_admission', admissionReference: 'provision-attempt-1', teamId: 'team-1', homeServerIdentityId: credentialTarget.serverId,
            },
        });
        expect(boundary.openUrl).toHaveBeenCalledWith('https://github.example.test/authorize?state=provision');
    });
});
