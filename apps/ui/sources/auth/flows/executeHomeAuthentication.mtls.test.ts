import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { executeHomeAuthentication } from './executeHomeAuthentication';

const boundary = vi.hoisted(() => {
    const environment: { scheme: string | undefined } = { scheme: undefined };
    return {
        request: vi.fn<RuntimeFetch>(),
        openUrl: vi.fn<(url: string) => Promise<void>>(),
        environment,
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeNativeMock({ platformOS: 'ios' }, {
        Linking: { openURL: boundary.openUrl },
    });
});
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: boundary.request }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('expo-constants')>();
    return {
        ...actual,
        default: {
            ...actual.default,
            expoConfig: {
                ...actual.default.expoConfig,
                get scheme() { return boundary.environment.scheme; },
            },
        },
    };
});

const target = {
    kind: 'descriptor' as const,
    authority: 'trusted_enrollment' as const,
    descriptor: {
        v: 1 as const,
        homeServerIdentityId: 'home-team',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://edge.example.test' }],
    },
};
const request = {
    method: { id: 'mtls', enabledActions: [{ id: 'login', mode: 'keyless' }] },
    action: { id: 'login', mode: 'keyless' },
    execution: { kind: 'mtls' },
    authority: { purpose: 'home', target },
    intendedHome: target,
} satisfies WelcomeAuthenticationMethod;
const credentialTarget = { serverId: 'home-team', serverUrl: 'https://edge.example.test' };

describe('executeHomeAuthentication native mTLS', () => {
    beforeEach(() => {
        boundary.request.mockReset();
        boundary.openUrl.mockReset();
        boundary.environment.scheme = undefined;
        boundary.request.mockResolvedValue(new Response(JSON.stringify({
            startUrl: '/v1/auth/mtls/start/browser?reference=opaque',
            admissionReference: 'mtls-admission-1',
        }), { status: 200 }));
        boundary.openUrl.mockResolvedValue(undefined);
    });

    it('prepares Team mTLS, stores only opaque Team custody, and opens the safe server URL', async () => {
        const onExternalAuthStarted = vi.fn();
        const onAuthenticated = vi.fn();

        await executeHomeAuthentication({
            request,
            loginWithCredentials: vi.fn(),
            returnTo: '/teams/team-1/sign-in?target=home-team',
            teamAdmission: { teamId: 'team-1', invitationToken: 'invitation-secret', origin: 'home' },
            onAuthenticated,
            onExternalAuthStarted,
        });

        expect(boundary.request).toHaveBeenCalledWith('https://edge.example.test/v1/auth/mtls/start', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                returnTo: 'happier:///mtls',
                teamId: 'team-1',
                admission: { kind: 'team_invitation', token: 'invitation-secret' },
            }),
        }));
        for (const [, init] of boundary.request.mock.calls) {
            expect(new Headers(init?.headers).has('authorization')).toBe(false);
        }
        const pending = await TokenStorage.readPendingExternalAuthStateForServerUrl(
            credentialTarget.serverUrl, { serverId: credentialTarget.serverId },
        );
        expect(pending).toEqual({
            value: {
                provider: 'mtls',
                ...credentialTarget,
                teamContinuation: {
                    v: 1,
                    purpose: 'team_admission',
                    admissionReference: 'mtls-admission-1',
                    teamId: 'team-1',
                    homeServerIdentityId: 'home-team',
                    destination: { kind: 'team_sign_in', teamId: 'team-1' },
                },
            },
            serverMismatch: false,
        });
        expect(JSON.stringify(pending)).not.toContain('invitation-secret');
        expect(boundary.openUrl).toHaveBeenCalledWith('https://edge.example.test/v1/auth/mtls/start/browser?reference=opaque');
        expect(onExternalAuthStarted).toHaveBeenCalledTimes(1);
        expect(onAuthenticated).not.toHaveBeenCalled();
    });

    it.each([
        { label: 'default', scheme: undefined, callbackUrl: 'happier:///mtls' },
        { label: 'configured', scheme: 'happier-dev', callbackUrl: 'happier-dev:///mtls' },
    ])('keeps ordinary Home mTLS on the released GET start contract with the $label app scheme', async ({ scheme, callbackUrl }) => {
        boundary.environment.scheme = scheme;
        const onExternalAuthStarted = vi.fn();
        const onAuthenticated = vi.fn();

        await executeHomeAuthentication({
            request,
            loginWithCredentials: vi.fn(),
            returnTo: '/setup/wizard',
            onAuthenticated,
            onExternalAuthStarted,
        });

        expect(boundary.request).not.toHaveBeenCalled();
        expect(await TokenStorage.readPendingExternalAuthStateForServerUrl(
            credentialTarget.serverUrl, { serverId: credentialTarget.serverId },
        )).toEqual({
            value: { provider: 'mtls', ...credentialTarget, returnTo: '/setup/wizard' },
            serverMismatch: false,
        });
        expect(boundary.openUrl).toHaveBeenCalledWith(
            `https://edge.example.test/v1/auth/mtls/start?returnTo=${encodeURIComponent(callbackUrl)}`,
        );
        expect(onExternalAuthStarted).toHaveBeenCalledOnce();
        expect(onAuthenticated).not.toHaveBeenCalled();
    });
});
