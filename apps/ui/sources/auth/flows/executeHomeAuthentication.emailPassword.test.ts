import { afterAll, beforeEach, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { executeHomeAuthentication } from './executeHomeAuthentication';

installTokenStorageWebPlatformMocks();
const browserStorage = await vi.hoisted(async () => {
    // Real Home persistence captures its browser backend while the owner loads.
    const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    return { ...installLocalStorageMock(), backend: globalThis.localStorage };
});
const boundary = vi.hoisted(() => ({ request: vi.fn<RuntimeFetch>() }));
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: boundary.request }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

beforeEach(() => {
    // Shared UI setup replaces this global; keep the originally captured backend.
    vi.stubGlobal('localStorage', browserStorage.backend);
    browserStorage.store.clear();
    boundary.request.mockReset();
    boundary.request.mockResolvedValue(new Response('{}', { status: 404 }));
});
afterAll(() => browserStorage.restore());

async function runGenericExecution(execution: unknown) {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const fixture = createDirectoryHttpFixture();
    const target = {
        kind: 'descriptor' as const,
        descriptor: fixture.home.connectionDescriptor,
        authority: 'current_connection' as const,
    };
    const outcome = await executeHomeAuthentication({
        // The generic helper must decide from the execution alone; the caller is
        // deliberately the ordinary Welcome/onboarding shape.
        request: {
            method: { id: 'email_password', enabledActions: [] },
            action: { id: 'provision', mode: 'either' },
            execution,
            authority: { purpose: 'home', target },
            intendedHome: target,
        } as never,
        loginWithCredentials: vi.fn(),
        returnTo: '/',
    });
    const pending = (await TokenStorage.readPendingExternalAuthState().catch(() => null))?.value ?? null;
    return { outcome, pending };
}

it('delegates email/password to its own controller instead of falling through to the mTLS tail', async () => {
    const { outcome, pending } = await runGenericExecution({ kind: 'email_password', action: 'provision', mode: 'either' });

    expect(pending).toBeNull();
    expect(boundary.request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'no_effect', reason: 'delegated_email_password' });
});

it('fails closed on an unknown execution kind rather than performing mTLS', async () => {
    const { outcome, pending } = await runGenericExecution({ kind: 'future_method_from_a_newer_home' });

    expect(pending).toBeNull();
    expect(boundary.request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'no_effect', reason: 'unsupported_execution' });
});

it.each([
    { label: 'launches a safe HTTPS URL and retains exact Home custody', url: 'https://provider.example.test/login', safe: true },
    { label: 'refuses an unsafe javascript URL and clears only target custody', url: 'javascript:alert(1)', safe: false },
])('ordinary Home OAuth $label', async ({ url, safe }) => {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const fixture = createDirectoryHttpFixture();
    const target = {
        kind: 'descriptor' as const,
        descriptor: fixture.home.connectionDescriptor,
        authority: 'current_connection' as const,
    };
    const credentialTarget = {
        serverId: target.descriptor.homeServerIdentityId,
        serverUrl: target.descriptor.canonicalServerUrl,
    };
    const otherHome = createDirectoryHttpFixture({ sameServiceHome: true }).home;
    const otherTarget = { serverId: otherHome.homeServerIdentityId, serverUrl: otherHome.canonicalServerUrl };
    const otherPending = { provider: 'github', proof: 'other-home-proof', returnTo: '/other-home', ...otherTarget };
    expect(await TokenStorage.setPendingExternalAuth(otherPending, otherTarget)).toBe(true);

    const action = { id: 'login', mode: 'keyless' } as const;
    const request = {
        method: { id: 'github', enabledActions: [action] },
        action,
        execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
        authority: { purpose: 'home', target },
        intendedHome: target,
    } satisfies WelcomeAuthenticationMethod;
    const assign = vi.fn();
    const onExternalAuthStarted = vi.fn();
    const onAuthenticated = vi.fn();
    boundary.request.mockResolvedValue(new Response(JSON.stringify({ url }), { status: 200 }));
    vi.stubGlobal('window', { location: { assign } });
    try {
        const outcome = await executeHomeAuthentication({
            request,
            loginWithCredentials: vi.fn(),
            returnTo: '/setup/wizard',
            onExternalAuthStarted,
            onAuthenticated,
        });

        expect(outcome).toEqual({ kind: 'handled' });
        expect(boundary.request).toHaveBeenCalled();
        for (const [input, init] of boundary.request.mock.calls) {
            expect(typeof input).toBe('string');
            const start = new URL(String(input));
            expect(start.origin).toBe(credentialTarget.serverUrl);
            expect(start.pathname).toBe('/v1/auth/external/github/params');
            expect([...start.searchParams.keys()].sort()).toEqual(['mode', 'proofHash']);
            expect(start.searchParams.get('mode')).toBe('keyless');
            expect(start.searchParams.get('proofHash')).toMatch(/^[a-f0-9]{64}$/);
            expect(init?.method ?? 'GET').toBe('GET');
            expect(new Headers(init?.headers).has('authorization')).toBe(false);
        }
        const pending = await TokenStorage.readPendingExternalAuthStateForServerUrl(
            credentialTarget.serverUrl, { serverId: credentialTarget.serverId },
        );
        expect(pending.serverMismatch).toBe(false);
        if (safe) {
            expect(assign).toHaveBeenCalledWith(url);
            expect(onExternalAuthStarted).toHaveBeenCalledOnce();
            expect(pending.value).toEqual({
                provider: 'github', proof: expect.any(String), returnTo: '/setup/wizard', ...credentialTarget,
            });
        } else {
            expect(assign).not.toHaveBeenCalled();
            expect(onExternalAuthStarted).not.toHaveBeenCalled();
            expect(pending.value).toBeNull();
        }
        expect(onAuthenticated).not.toHaveBeenCalled();
        expect((await TokenStorage.readPendingExternalAuthStateForServerUrl(
            otherTarget.serverUrl, { serverId: otherTarget.serverId },
        )).value).toEqual(otherPending);
    } finally {
        vi.unstubAllGlobals();
    }
});
