import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { useAuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { createRootLayoutFeaturesResponse, createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { parsePendingTerminalConnectPreAuthEnvelope } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { MMKV } from 'react-native-mmkv';
import { clearPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import type { IrohHomeRuntimeOriginLease, IrohHomeTunnelAcquireInput } from '@/sync/runtime/nativeIrohTunnels/types';

installTokenStorageWebPlatformMocks();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const replaceSpy = vi.hoisted(() => vi.fn());
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
const routeBoundary = vi.hoisted(() => ({ params: {} as Record<string, string> }));
const nativeBoundary = vi.hoisted(() => ({ acquire: vi.fn<(input: IrohHomeTunnelAcquireInput) => Promise<IrohHomeRuntimeOriginLease>>() }));

vi.mock('@/sync/runtime/browserIroh/hostEligibility', () => ({
    // Platform boundary: exercise delayed native discovery and its real enrollment policy.
    resolveBrowserIrohHostDecision: () => ({ eligible: false, reason: 'not_web' }),
}));
vi.mock('@/sync/runtime/nativeIrohTunnels/runtime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/nativeIrohTunnels/runtime')>(),
    acquireIrohHomeRuntimeOrigin: nativeBoundary.acquire,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => routeBoundary.params, router: { replace: replaceSpy } }).module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    // Presentation boundary: pairing continuity does not depend on locale catalogs.
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/text/i18n', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return { ...createTextModuleMock(), setPreferredLanguageFromSettings: vi.fn() };
});
const runtimeFetchSpy = vi.hoisted(() => vi.fn<typeof import('@/utils/system/runtimeFetch').runtimeFetch>(async () => new Response('', { status: 503 })));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: runtimeFetchSpy,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmSpy } }).module;
});

const { default: TerminalConnectScreen } = await import('./connect');
const { default: TerminalScreen } = await import('./index');

function signedOut({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>;
}

function createStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => { values.delete(key); },
        setItem: (key, value) => { values.set(key, value); },
    };
}

function terminalRequest(serverUrl: string, serverIdentityId: string) {
    return {
        publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        serverUrl,
        serverIdentityId,
        pairing: {
            secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
            createdAtMs: 1_900_000_000_000,
            expiresAtMs: 1_900_000_060_000,
        },
    };
}

let restoreLocks: (() => void) | undefined;
beforeEach(() => { restoreLocks = installWebLockManagerMock().restore; });
afterEach(async () => {
    await standardCleanup();
    clearPendingTerminalConnect();
    replaceSpy.mockClear();
    confirmSpy.mockReset();
    confirmSpy.mockResolvedValue(true);
    routeBoundary.params = {};
    nativeBoundary.acquire.mockReset();
    restoreLocks?.();
    vi.unstubAllGlobals();
});

it('does not redirect preauth terminal pairing to an unreachable unsaved Home', async () => {
    runtimeFetchSpy.mockClear();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    vi.stubGlobal('window', {
        location: {
            href: `https://app.example.test${buildTerminalConnectWebHref(terminalRequest('https://unreachable.example.test', 'srv_new_home'))}`,
            pathname: '/terminal/connect',
        },
        history: { replaceState: vi.fn() },
        sessionStorage: globalThis.sessionStorage,
    });
    vi.stubGlobal('document', { getElementById: () => null });
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { listServerProfiles, resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
    resetServerProfilesRuntimeForTests();

    await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}><TerminalConnectScreen /></InjectedAuthProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(runtimeFetchSpy).toHaveBeenCalledWith('https://unreachable.example.test/health', expect.any(Object));
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(listServerProfiles().some((profile) => profile.serverUrl === 'https://unreachable.example.test')).toBe(false);
    await screen.unmount();
});

it('adopts a preauth terminal Home address and opens its sign-in without changing the selected service', async () => {
    const address = 'https://accounts.example.test';
    const captured = terminalRequest(address, 'srv_accounts_entry');
    runtimeFetchSpy.mockImplementation(async (...args: unknown[]) => {
        const url = String(args[0]);
        return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : createSignInServiceFeaturesResponse(address)), {
            status: url.endsWith('/health') || url.endsWith('/v1/features') ? 200 : 404, headers: { 'content-type': 'application/json' },
        });
    });
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    vi.stubGlobal('window', {
        location: { href: `https://app.example.test${buildTerminalConnectWebHref(captured)}`, pathname: '/terminal/connect' },
        history: { replaceState: vi.fn() }, sessionStorage: globalThis.sessionStorage,
    });
    vi.stubGlobal('document', { getElementById: () => null });
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const pending = await import('@/sync/domains/pending/pendingTerminalConnect');
    const active = await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
    const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}><TerminalConnectScreen /></InjectedAuthProvider>);
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalledWith(`/?server=${encodeURIComponent(address)}`));
    expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
    expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === address)).toBe(true);
    expect(profiles.getActiveServerId()).not.toBe(active.id);
    expect(pending.getPendingTerminalConnect()).toMatchObject(captured);
    const custodyStorage = new MMKV({ id: scopedStorageId('pending-terminal-connect', readStorageScopeFromEnv()) });
    const envelope = parsePendingTerminalConnectPreAuthEnvelope(JSON.parse(custodyStorage.getString('record:pre-auth:v1')!));
    expect(envelope?.record).toMatchObject(captured);
    await screen.unmount();
});

it.each(['web-link', 'native-link', 'scanner-hook'])(
    'opens descriptor Home sign-in over its HTTPS endpoint while keeping canonical pairing custody (%s)',
    async (entryPoint) => {
    const homeConnectionDescriptor = {
        v: 1 as const,
        homeServerIdentityId: 'srv_descriptor_entry',
        canonicalServerUrl: 'http://localhost:3010',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://descriptor-entry.example.test' }],
    };
    const captured = {
        ...terminalRequest(homeConnectionDescriptor.canonicalServerUrl, homeConnectionDescriptor.homeServerIdentityId),
        homeConnectionDescriptor,
    };
    let custodyAtHashClear: unknown;
    runtimeFetchSpy.mockImplementation(async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.endsWith('/v1/auth/entry')) return new Response('', { status: 404 });
        return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : createRootLayoutFeaturesResponse({
            capabilities: {
                server: { canonicalServerUrl: homeConnectionDescriptor.canonicalServerUrl },
                serverIdentity: { serverIdentityId: homeConnectionDescriptor.homeServerIdentityId },
            },
        })), {
            status: url.endsWith('/health') || url.endsWith('/v1/features') ? 200 : 404,
            headers: { 'content-type': 'application/json' },
        });
    });
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    vi.stubGlobal('window', {
        location: { href: `https://app.example.test${buildTerminalConnectWebHref(captured)}`, pathname: '/terminal/connect' },
        history: { replaceState: vi.fn(() => {
            const storage = new MMKV({ id: scopedStorageId('pending-terminal-connect', readStorageScopeFromEnv()) });
            const raw = storage.getString('record:pre-auth:v1');
            custodyAtHashClear = raw ? parsePendingTerminalConnectPreAuthEnvelope(JSON.parse(raw))?.record : null;
        }) }, sessionStorage: globalThis.sessionStorage,
    });
    vi.stubGlobal('document', { getElementById: () => null });
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
    const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
    const href = buildTerminalConnectWebHref(captured);
    routeBoundary.params = Object.fromEntries(new URLSearchParams(href.split('#')[1]));
    const screen = entryPoint === 'scanner-hook'
        ? await renderHook(() => useConnectTerminal(), { wrapper: signedOut })
        : await renderScreen(<InjectedAuthProvider credentials={null}>
            {entryPoint === 'native-link' ? <TerminalScreen /> : <TerminalConnectScreen />}
        </InjectedAuthProvider>);
    if ('getCurrent' in screen) {
        await act(async () => {
            await screen.getCurrent().processAuthUrl(`https://app.example.test${href}`);
        });
    }
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalledWith(`/?server=${encodeURIComponent(homeConnectionDescriptor.canonicalServerUrl)}`));
    if (entryPoint === 'web-link') expect(custodyAtHashClear).toMatchObject(captured);

    expect(profiles.getActiveServerSnapshot()).toMatchObject({
        serverUrl: homeConnectionDescriptor.canonicalServerUrl,
    });
    const authEntry = await renderHook(() => useAuthEntryOptions(), { wrapper: signedOut });
    await vi.waitFor(() => expect(authEntry.getCurrent().serverAvailability).toBe('ready'));
    expect(authEntry.getCurrent().homeTransport).toMatchObject({ runtimeOrigin: homeConnectionDescriptor.endpoints[0].url });
    expect(authEntry.getCurrent().observedHomeServerIdentityId).toBe(homeConnectionDescriptor.homeServerIdentityId);
    expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
    const custodyStorage = new MMKV({ id: scopedStorageId('pending-terminal-connect', readStorageScopeFromEnv()) });
    const envelope = parsePendingTerminalConnectPreAuthEnvelope(JSON.parse(custodyStorage.getString('record:pre-auth:v1')!));
    expect(envelope?.record).toMatchObject(captured);
    expect(runtimeFetchSpy.mock.calls.some((args) => String(args[0]).startsWith('http://localhost:3010/'))).toBe(false);
    await authEntry.unmount();
    await screen.unmount();
});

it('retains an unavailable descriptor pairing without changing focus or redirecting through the focused Home', async () => {
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const active = await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
    const captured = {
        ...terminalRequest('http://localhost:3011', 'srv_unavailable_entry'),
        homeConnectionDescriptor: {
            v: 1 as const,
            homeServerIdentityId: 'srv_unavailable_entry',
            canonicalServerUrl: 'http://localhost:3011',
            revision: 1,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'b'.repeat(64) }],
        },
    };
    const hook = await renderHook(() => useConnectTerminal(), { wrapper: signedOut });
    let result = true;
    await act(async () => {
        result = await hook.getCurrent().processAuthUrl(`https://app.example.test${buildTerminalConnectWebHref(captured)}`);
    });
    expect(result).toBe(false);
    expect(profiles.getActiveServerId()).toBe(active.id);
    expect(replaceSpy).not.toHaveBeenCalled();
    const custodyStorage = new MMKV({ id: scopedStorageId('pending-terminal-connect', readStorageScopeFromEnv()) });
    const envelope = parsePendingTerminalConnectPreAuthEnvelope(JSON.parse(custodyStorage.getString('record:pre-auth:v1')!));
    expect(envelope?.record).toMatchObject(captured);
    await hook.unmount();
});

it('retains the web intent across a remount while transport discovery is pending', async () => {
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    await runtime.upsertAndActivateServer({ serverUrl: 'https://other-home.example.test', scope: 'device' });
    const captured = {
        ...terminalRequest('http://localhost:3016', 'srv_delayed_discovery'),
        homeConnectionDescriptor: {
            v: 1 as const, homeServerIdentityId: 'srv_delayed_discovery', canonicalServerUrl: 'http://localhost:3016',
            revision: 1, endpoints: [{ kind: 'iroh' as const, endpointId: 'c'.repeat(64) }],
        },
    };
    const acquisition = createDeferred<IrohHomeRuntimeOriginLease>();
    nativeBoundary.acquire.mockImplementation(() => acquisition.promise);
    const location = { href: `https://app.example.test${buildTerminalConnectWebHref(captured)}`, pathname: '/terminal/connect' };
    vi.stubGlobal('window', {
        location, sessionStorage: globalThis.sessionStorage,
        history: { replaceState: vi.fn((_state, _title, url: string) => { location.href = `https://app.example.test${url}`; }) },
    });
    vi.stubGlobal('document', { getElementById: () => null });
    const first = await renderScreen(<InjectedAuthProvider credentials={null}><TerminalConnectScreen /></InjectedAuthProvider>);
    await vi.waitFor(() => expect(nativeBoundary.acquire).toHaveBeenCalled());
    await first.unmount();
    const resumed = await renderScreen(<InjectedAuthProvider credentials={null}><TerminalConnectScreen /></InjectedAuthProvider>);
    try {
        acquisition.reject(Object.assign(new Error('unavailable'), { name: 'IrohError', code: 'unavailable' }));
        const { TerminalConnectSurface } = await import('@/components/terminalConnect/TerminalConnectSurface');
        await vi.waitFor(() => expect(resumed.findByType(TerminalConnectSurface).props.state).toMatchObject({
            kind: 'message', tone: 'critical', description: expect.stringContaining(captured.serverUrl),
        }));
        expect(replaceSpy).not.toHaveBeenCalled();
    } finally {
        await resumed.unmount();
    }
});

it('keeps an authenticated Home focused when its user declines a descriptor pairing Home switch', async () => {
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const active = await upsertAndActivateServer({ serverUrl: 'https://saved.example.test', source: 'manual', scope: 'device' });
    const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
    const descriptor = {
        v: 1 as const,
        homeServerIdentityId: 'srv_declined_entry',
        canonicalServerUrl: 'https://declined.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://declined.example.test' }],
    };
    const credentials: AuthCredentials = { token: 'focused-account-token' };
    function focusedAccount({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    }
    confirmSpy.mockResolvedValueOnce(false);
    const hook = await renderHook(() => useConnectTerminal(), { wrapper: focusedAccount });
    await act(async () => {
        await hook.getCurrent().processAuthUrl(`https://app.example.test${buildTerminalConnectWebHref({
            ...terminalRequest(descriptor.canonicalServerUrl, descriptor.homeServerIdentityId),
            homeConnectionDescriptor: descriptor,
        })}`);
    });
    expect(profiles.getActiveServerId()).toBe(active.id);
    expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
    expect(profiles.listServerProfiles().some((profile) => profile.serverIdentityId === descriptor.homeServerIdentityId)).toBe(false);
    expect(replaceSpy).not.toHaveBeenCalled();
    const custodyStorage = new MMKV({ id: scopedStorageId('pending-terminal-connect', readStorageScopeFromEnv()) });
    expect(custodyStorage.getString('record:pre-auth:v1')).toBeUndefined();
    await hook.unmount();
});

it.each(['https-origin', 'native-iroh-origin', 'browser-iroh-carrier'] as const)(
    'borrows the authenticated active transport while exact descriptor reconciliation is pending (%s)', async (transportKind) => {
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    const descriptor = {
        v: 1 as const, homeServerIdentityId: 'srv_new_signin_pending', canonicalServerUrl: 'http://localhost:3015',
        revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://new-signin.example.test' }],
    };
    const profile = await profiles.adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'advisory' });
    await runtime.setActiveServer({ serverId: profile.id, scope: 'device' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials: AuthCredentials = { token: 'new-signin-issued-token' };
    expect(await TokenStorage.setCredentialsForServerUrl(descriptor.canonicalServerUrl, {
        serverId: descriptor.homeServerIdentityId,
    }, credentials)).toBe(true);
    expect(profiles.getServerProfileById(profile.id)?.descriptorProvenance).toBe('advisory-only');
    const runtimeOrigin = transportKind === 'native-iroh-origin'
        ? 'http://127.0.0.1:43315' : descriptor.endpoints[0].url;
    const carrierRequest = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
    }));
    // The active connection owner publishes this handle only after its authenticated
    // carrier proof. The request function is the external byte-transport boundary.
    const homeCarrier = {
        endpointId: 'authenticated-browser-endpoint', readObservedPath: () => 'relay' as const,
        request: carrierRequest, createWebSocket: vi.fn(),
    };
    const target = runtime.captureActiveServerRuntimeTarget();
    expect(runtime.publishActiveServerRuntimeOrigin({
        target, leaseId: 'authenticated-active-signin', carrier: transportKind === 'https-origin' ? 'https' : 'iroh',
        ...(transportKind === 'browser-iroh-carrier' ? { homeCarrier } : { runtimeOrigin }),
    })).toBe(true);
    runtimeFetchSpy.mockClear();
    runtimeFetchSpy.mockImplementation(async (...args: unknown[]) => new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), {
        status: String(args[0]).startsWith(runtimeOrigin) ? 200 : 503,
        headers: { 'content-type': 'application/json' },
    }));
    function newlySignedIn({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    }
    const request = {
        ...terminalRequest(descriptor.canonicalServerUrl, descriptor.homeServerIdentityId),
        homeConnectionDescriptor: {
            ...descriptor, endpoints: [{ kind: 'https' as const, url: 'https://untrusted-advice.example.test' }],
        },
    };
    const hook = await renderHook(() => useConnectTerminal({ approvalRequest: request }), { wrapper: newlySignedIn });
    await vi.waitFor(() => expect(hook.getCurrent().approvalDetails).toEqual({
        kind: 'ready', homeUrl: descriptor.canonicalServerUrl, storageMode: 'plain',
    }));
    expect(runtimeFetchSpy.mock.calls.some((args) => String(args[0]).startsWith(descriptor.canonicalServerUrl))).toBe(false);
    expect(runtimeFetchSpy.mock.calls.some((args) => String(args[0]).includes('untrusted-advice'))).toBe(false);
    const modeRead = transportKind === 'browser-iroh-carrier'
        ? carrierRequest.mock.calls[0] : runtimeFetchSpy.mock.calls.find((args) => String(args[0]).endsWith('/v1/account/encryption'));
    expect(modeRead).toBeDefined();
    expect(new Headers((modeRead![1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${credentials.token}`);
    await hook.unmount();
    if (transportKind === 'browser-iroh-carrier') expect(runtime.getActiveServerHomeCarrier()).toBe(homeCarrier);
    else expect(runtime.getActiveServerSnapshot().runtimeOrigin).toBe(runtimeOrigin);
    expect(runtime.releaseActiveServerRuntimeOrigin({ target, leaseId: 'authenticated-active-signin' })).toBe(true);
});

it.each(['unpublished', 'different-home'] as const)(
    'withholds saved advisory-profile credentials without an exact verified transport (%s)', async (activeTransport) => {
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    const descriptor = {
        v: 1 as const, homeServerIdentityId: 'srv_advisory_only', canonicalServerUrl: 'https://advisory-only.example.test',
        revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://advised-carrier.example.test' }],
    };
    const profile = await profiles.adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'advisory' });
    await runtime.setActiveServer({ serverId: profile.id, scope: 'device' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials: AuthCredentials = { token: 'saved-advisory-token' };
    await TokenStorage.setCredentialsForServerUrl(descriptor.canonicalServerUrl, { serverId: descriptor.homeServerIdentityId }, credentials);
    if (activeTransport === 'different-home') {
        await runtime.upsertAndActivateServer({ serverUrl: 'https://different-home.example.test', scope: 'device' });
        expect(runtime.publishActiveServerRuntimeOrigin({
            target: runtime.captureActiveServerRuntimeTarget(), leaseId: 'different-home-lease',
            runtimeOrigin: 'https://different-home-carrier.example.test', carrier: 'https',
        })).toBe(true);
    }
    runtimeFetchSpy.mockClear();
    const request = { ...terminalRequest(descriptor.canonicalServerUrl, descriptor.homeServerIdentityId), homeConnectionDescriptor: descriptor };
    function authenticated({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    }
    const hook = await renderHook(() => useConnectTerminal({ approvalRequest: request }), { wrapper: authenticated });
    await vi.waitFor(() => expect(hook.getCurrent().approvalDetails).toEqual({ kind: 'error' }));
    expect(runtimeFetchSpy).not.toHaveBeenCalled();
    expect(await TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, {
        serverId: descriptor.homeServerIdentityId,
    })).toEqual(credentials);
    await hook.unmount();
});

it('reads the target Account mode for approval preview without using focused Account key material', async () => {
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.resetServerProfilesRuntimeForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const focused = await upsertAndActivateServer({ serverUrl: 'https://focused-e2ee.example.test', source: 'manual', scope: 'device' });
    const descriptor = {
        v: 1 as const,
        homeServerIdentityId: 'srv_plain_preview',
        canonicalServerUrl: 'https://plain-preview.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://plain-preview.example.test' }],
    };
    await profiles.adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const targetCredentials: AuthCredentials = { token: 'plain-preview-account-token' };
    expect(await TokenStorage.setCredentialsForServerUrl(descriptor.canonicalServerUrl, {
        serverId: descriptor.homeServerIdentityId,
    }, targetCredentials)).toBe(true);
    const focusedCredentials: AuthCredentials = {
        token: 'focused-e2ee-account-token',
        secret: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
    };
    function focusedAccount({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={focusedCredentials}>{children}</InjectedAuthProvider>;
    }
    runtimeFetchSpy.mockClear();
    runtimeFetchSpy.mockImplementation(async (...args: unknown[]) => {
        const url = String(args[0]);
        return new Response(JSON.stringify({ mode: url.startsWith(descriptor.canonicalServerUrl) ? 'plain' : 'e2ee', updatedAt: 0 }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    });
    const request = {
        ...terminalRequest(descriptor.canonicalServerUrl, descriptor.homeServerIdentityId),
        homeConnectionDescriptor: descriptor,
    };
    const hook = await renderHook(() => useConnectTerminal({ approvalRequest: request }), { wrapper: focusedAccount });
    await vi.waitFor(() => expect(hook.getCurrent().approvalDetails).toEqual({
        kind: 'ready', homeUrl: descriptor.canonicalServerUrl, storageMode: 'plain',
    }));
    expect(profiles.getActiveServerId()).toBe(focused.id);
    const modeReads = runtimeFetchSpy.mock.calls.filter((args) => String(args[0]).endsWith('/v1/account/encryption'));
    expect(modeReads).toHaveLength(1);
    expect(String(modeReads[0][0])).toBe(`${descriptor.canonicalServerUrl}/v1/account/encryption`);
    expect(new Headers(modeReads[0][1]?.headers).get('authorization')).toBe(`Bearer ${targetCredentials.token}`);
    await hook.unmount();

    // A link can repeat a saved Home id; that is not authority to reroute its bearer.
    const forgedUrl = 'https://untrusted-pairing-endpoint.example.test';
    const forgedRequest = {
        ...request,
        serverUrl: forgedUrl,
        homeConnectionDescriptor: {
            ...descriptor,
            canonicalServerUrl: forgedUrl,
            endpoints: [{ kind: 'https' as const, url: forgedUrl }],
        },
    };
    runtimeFetchSpy.mockClear();
    const forgedHook = await renderHook(() => useConnectTerminal({ approvalRequest: forgedRequest }), { wrapper: focusedAccount });
    await vi.waitFor(() => expect(forgedHook.getCurrent().approvalDetails).toEqual({
        kind: 'ready', homeUrl: descriptor.canonicalServerUrl, storageMode: 'plain',
    }));
    expect(runtimeFetchSpy.mock.calls.filter((args) => String(args[0]).endsWith('/v1/account/encryption'))
        .map((args) => String(args[0]))).toEqual([`${descriptor.canonicalServerUrl}/v1/account/encryption`]);
    await forgedHook.unmount();
});
