import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { IrohMachineHandshakeV1Schema, PeerTcpTunnelOpenV2Schema, verifyPeerRouteEphemeralProofV2 } from '@happier-dev/protocol';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { withDirectConnectionsEnabled, withMachineDirectConnectionChoice } from '@/sync/domains/settings/peerMediationPreferences';
import { acquireNativeDirectPreviewAccess, acquireServerPreviewAccess } from './nativeDirectAccess';
import { useNativeDirectPreview, type NativeDirectPreviewInput } from './useNativeDirectPreview';

const boundaries = vi.hoisted(() => ({
    fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
    credentialsToken: 'header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature',
    platformOS: 'web' as 'web' | 'ios',
    appState: 'active',
    appStateListeners: new Set<() => void>(),
}));

// Only OS, secure-storage, and HTTP/native transport boundaries are replaced.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: boundaries.credentialsToken }),
    } });
});
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: Parameters<typeof boundaries.fetch>) => boundaries.fetch(...args) }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return boundaries.platformOS; } },
        AppState: {
            get currentState() { return boundaries.appState; },
            addEventListener: (_event: string, listener: () => void) => {
                boundaries.appStateListeners.add(listener);
                return { remove: () => boundaries.appStateListeners.delete(listener) };
            },
        },
    });
});

const desktopAvailability = {
    available: true, platform: 'macos', primitive: 'macosNsViewWebKit', renderEngine: 'desktopWebView',
    producer: 'tauriWryNativeChildView', privilegedIpc: false,
    supports: { navigation: true, goBackForward: false, reload: false, stop: false, pageInfoDiagnostics: true, nativeDevtools: true, capture: false, recording: false, automation: false },
    disabledReasons: [],
} as const;

function accessResponse(request: Record<string, unknown>) {
    return {
        v: 1, kind: 'iroh_preview', previewId: 'preview-1', machineId: 'machine-1', initialPath: { pathname: '/start', search: '' },
        destination: { host: '127.0.0.1', port: 5173 },
        target: { endpointId: 'a'.repeat(64), revision: 1, directAddresses: ['127.0.0.1:43123'], relayUrls: ['https://relay.example.test'] },
        grant: {
            payload: {
                v: 2, proofKind: 'ephemeral_ed25519', grantId: 'grant-1', accountId: 'owner-account', machineId: 'machine-1',
                flowKind: 'tcp_tunnel', routeKind: 'iroh_peer', endpointFingerprint: 'a'.repeat(64),
                scope: { kind: 'tcp_tunnel', tunnelId: 'preview-tunnel-1', allowedPorts: [5173], preview: {
                    previewId: 'preview-1', machineId: 'machine-1', owner: { kind: 'user', id: 'owner-account' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                } },
                iroh: { initiator: request.initiator, target: { machineId: 'machine-1', endpointId: 'a'.repeat(64) }, operationKind: 'tcp_tunnel' },
                ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                iat: 1, exp: null, aud: 'happier-daemon-route-grant',
            },
            signature: { keyId: 'server-key', alg: 'Ed25519', valueBase64Url: Buffer.alloc(64, 1).toString('base64url') },
        },
    };
}

function serverAccessResponse(token = 'fresh-server-admission') {
    return {
        v: 1, kind: 'server_preview', previewId: 'preview-1', machineId: 'machine-1',
        accessUrl: `https://preview.example.test/start?previewToken=${token}`, expiresAt: 2_000_000_000_000,
    };
}

function isServerAccessCall(init?: RequestInit): boolean {
    if (typeof init?.body !== 'string') return false;
    return JSON.parse(String(init?.body)).kind === 'server_preview';
}

let serverId: string;
const fallbackUrl = 'https://preview.example.test/start';
const baseInput: NativeDirectPreviewInput = { previewId: 'preview-1', machineId: 'machine-1', enabled: true, fallbackUrl };

beforeEach(async () => {
    boundaries.invoke.mockReset();
    boundaries.fetch.mockReset();
    boundaries.credentialsToken = 'header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature';
    boundaries.platformOS = 'web';
    boundaries.appState = 'active';
    boundaries.appStateListeners.clear();
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: boundaries.invoke });
    boundaries.invoke.mockImplementation(async (command) => {
        if (command === 'iroh_get_availability') return { available: true };
        if (command === 'iroh_get_application_endpoint') return { endpointId: 'b'.repeat(64) };
        if (command === 'iroh_start_machine_tunnel') return { leaseId: 'lease-1', localPort: 42123 };
        if (command === 'iroh_stop_machine_tunnel') return null;
        if (command === 'desktop_browser_get_availability') return desktopAvailability;
        if (command === 'desktop_browser_drain_diagnostics') return { ok: true, availability: desktopAvailability, messages: [] };
        if (command.startsWith('desktop_browser_')) return { ok: true, availability: desktopAvailability };
        throw new Error(`Unexpected native operation ${command}`);
    });
    boundaries.fetch.mockImplementation(async (url, init) => {
        if (url.includes('/access')) return Response.json(isServerAccessCall(init) ? serverAccessResponse() : accessResponse(JSON.parse(String(init?.body))));
        return Response.json({ ok: true });
    });
    const profile = await upsertServerProfile({ serverUrl: 'https://preview-home.example.test' });
    serverId = profile.id;
    saveAccountSettings({ serverId, accountId: 'viewer-account' }, settingsDefaults, 1);
    storage.setState((state) => ({
        localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'automatic' },
        settingsScope: null,
        settings: settingsDefaults,
    }));
});

afterEach(async () => {
    standardCleanup();
    await flushHookEffects();
    const { releaseRetainedIrohMachineTransferLeases } = await import('@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle');
    await releaseRetainedIrohMachineTransferLeases();
    vi.unstubAllGlobals();
});

describe('native preview viewer access', () => {
    it('opens an already registered web preview through viewer admission without a custodian URL or native renderer', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        const hook = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId, fallbackUrl: null } });
        try {
            await flushHookEffects({ cycles: 40 });
            expect(hook.getCurrent()).toMatchObject({ url: `${fallbackUrl}?previewToken=fresh-server-admission`,
                localOrigin: null, acquiring: false });
            expect(boundaries.invoke.mock.calls.some(([command]) => command === 'iroh_start_machine_tunnel')).toBe(false);
        } finally { await hook.unmount(); }
    });
    it('uses only Home HTTP for a target-only desktop view without native registration metadata', async () => {
        const { BrowserViewHost } = await import('@/components/browser/BrowserViewHost');
        const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const view: BrowserControlViewState = {
            browserSessionId: 'target-browser', viewId: 'target-view', target: {
                kind: 'localServicePreview', targetId: 'preview-1', machineId: 'machine-1', display: { title: 'Web' } },
            platform: 'desktop', adapterKind: 'localPreview', engineKind: 'desktopWebView',
            adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview', supportedTargetKinds: ['localServicePreview'],
                supportedRenderEngines: ['desktopWebView'], desktopWebViewSupport: desktopAvailability.supports }),
            currentUrl: null, currentUrlExpiresAt: null, pendingUrl: null, title: 'Web', faviconUrl: null,
            loadingState: 'idle', loadingProgress: null, navigationGeneration: 0, canGoBack: false, canGoForward: false,
            securityOrigin: null, lastError: null, openerViewId: null, adapterRefreshStatus: 'idle', adapterRefreshError: null,
        };
        const screen = await renderScreen(React.createElement(BrowserViewHost, { view, localServicePreviewServerId: serverId }));
        try {
            await flushHookEffects({ cycles: 40 });
            expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(true);
            expect(boundaries.invoke.mock.calls.some(([command]) => command === 'iroh_start_machine_tunnel')).toBe(false);
        } finally { await screen.unmount(); }
    });
    it('mints a shareable server URL for a web viewer using its actual captured Home Account credential', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        let authenticatedViewerReached = false;
        boundaries.fetch.mockImplementation(async (url, init) => {
            if (url === 'https://preview-home.example.test/v1/local-services/preview/preview-1/access'
                && new Headers(init?.headers).get('Authorization') === `Bearer ${boundaries.credentialsToken}`
                && isServerAccessCall(init)) {
                authenticatedViewerReached = true;
                return Response.json(serverAccessResponse('web-viewer-admission'));
            }
            return Response.json({ error: 'preview_access_denied' }, { status: 403 });
        });
        expect(await acquireServerPreviewAccess({ previewId: 'preview-1', machineId: 'machine-1', serverId }))
            .toBe('https://preview.example.test/start?previewToken=web-viewer-admission');
        expect(authenticatedViewerReached).toBe(true);
        expect(await acquireServerPreviewAccess({ previewId: 'preview-1', machineId: 'another-machine', serverId })).toBeNull();
    });
    it('mints fresh preview access and binds the native handshake and inner open to the same proof', async () => {
        const lease = await acquireNativeDirectPreviewAccess({ ...baseInput, previewId: 'preview-1', machineId: 'machine-1', serverId });
        expect(lease?.localOrigin).toBe('http://127.0.0.1:42123');
        const issued = boundaries.fetch.mock.calls.find(([url]) => url.endsWith('/v1/local-services/preview/preview-1/access'));
        expect(new Headers(issued?.[1]?.headers).get('Authorization')).toBe('Bearer header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature');
        const started = boundaries.invoke.mock.calls.find(([command]) => command === 'iroh_start_machine_tunnel');
        const request = started?.[1]?.request as { handshakeJson: string; nativeHttpLease: { openJson: string } };
        const handshake = IrohMachineHandshakeV1Schema.parse(JSON.parse(request.handshakeJson));
        const open = PeerTcpTunnelOpenV2Schema.parse(JSON.parse(request.nativeHttpLease.openJson));
        expect(handshake.accountId).toBe('owner-account');
        expect(open).toMatchObject({ tunnelId: 'preview-tunnel-1', targetMachineId: 'machine-1', destination: { host: '127.0.0.1', port: 5173 } });
        expect(open.grant).toEqual(handshake.grant);
        expect(open.proof).toEqual(handshake.proof);
        expect(verifyPeerRouteEphemeralProofV2({ grant: open.grant, proof: open.proof })).toEqual({ valid: true });
        await lease?.release();
    });

    it('retains one lease across snapshot and navigation updates, then releases on revoke', async () => {
        const initialProps: NativeDirectPreviewInput = { ...baseInput, serverId, fallbackUrl: `${fallbackUrl}?previewToken=server-secret` };
        const hook = await renderHook(useNativeDirectPreview, { initialProps });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent()).toMatchObject({ url: 'http://127.0.0.1:42123/start', acquiring: false });
        await hook.rerender({ ...baseInput, serverId, fallbackUrl: 'https://preview.example.test/start?new=1', requestedUrl: 'https://preview.example.test/docs?x=1#heading' });
        expect(hook.getCurrent().url).toBe('http://127.0.0.1:42123/docs?x=1#heading');
        await hook.rerender({ ...baseInput, serverId, fallbackUrl: `${fallbackUrl}?previewToken=server-secret`, requestedUrl: 'https://preview.example.test/docs?previewToken=server-secret&x=2#heading' });
        expect(hook.getCurrent().url).toBe('http://127.0.0.1:42123/docs?x=2#heading');
        await hook.rerender({ ...baseInput, serverId, requestedUrl: 'https://external.example.test/docs?x=1' });
        expect(hook.getCurrent().url).toBe('https://external.example.test/docs?x=1');
        await hook.rerender({ ...baseInput, serverId, requestedUrl: 'http://127.0.0.1:49999/stale?secret=1' });
        expect(hook.getCurrent().url).toBe('http://127.0.0.1:42123/start');
        await hook.rerender({ ...baseInput, serverId, requestedUrl: 'https://preview.example.test//same-origin-path?x=1' });
        expect(hook.getCurrent().url).toBe('http://127.0.0.1:42123//same-origin-path?x=1');
        expect(boundaries.fetch.mock.calls.filter(([url]) => url.includes('/access'))).toHaveLength(1);
        await hook.rerender({ ...baseInput, serverId, previewId: null });
        expect(hook.getCurrent().localOrigin).toBeNull();
        expect(boundaries.invoke.mock.calls.filter(([command]) => command === 'iroh_stop_machine_tunnel')).toHaveLength(1);
        await hook.unmount();
    });

    it('cleans up a listener that finishes starting after the viewer unmounts', async () => {
        const pending = createDeferred<unknown>();
        const nativeDefault = boundaries.invoke.getMockImplementation()!;
        boundaries.invoke.mockImplementation((command, args) => command === 'iroh_start_machine_tunnel' ? pending.promise : nativeDefault(command, args));
        const hook = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId, fallbackUrl: null, requestedUrl: '/pending?x=1' } });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().acquiring).toBe(true);
        expect(hook.getCurrent().url).toBeNull();
        await hook.unmount();
        await act(async () => { pending.resolve({ leaseId: 'late-lease', localPort: 42124 }); });
        await flushHookEffects({ cycles: 10 });
        expect(boundaries.invoke.mock.calls).toContainEqual(['iroh_stop_machine_tunnel', { leaseId: 'late-lease' }]);
    });

    it('refreshes server admission without minting native access when Standard-only is selected', async () => {
        const hook = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId } });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().localOrigin).toBe('http://127.0.0.1:42123');
        await act(async () => { storage.setState((state) => ({ localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'standard_only' } })); });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent()).toMatchObject({ url: `${fallbackUrl}?previewToken=fresh-server-admission`, localOrigin: null, acquiring: false });
        expect(boundaries.fetch.mock.calls.filter(([url, init]) => url.includes('/access') && isServerAccessCall(init))).toHaveLength(1);
        const mintedBefore = boundaries.fetch.mock.calls.filter(([url]) => url.includes('/access')).length;
        expect(await acquireNativeDirectPreviewAccess({ previewId: 'preview-1', machineId: 'machine-1', serverId })).toBeNull();
        expect(boundaries.fetch.mock.calls.filter(([url]) => url.includes('/access'))).toHaveLength(mintedBefore);
        await hook.rerender({ ...baseInput, serverId, requestedUrl: 'http://127.0.0.1:42123/docs?x=1#heading' });
        expect(hook.getCurrent().url).toBe('https://preview.example.test/docs?x=1&previewToken=fresh-server-admission#heading');
        await hook.rerender({ ...baseInput, serverId, fallbackUrl: `${fallbackUrl}?previewToken=fallback-admission`, requestedUrl: 'http://127.0.0.1:42123/docs?x=1#heading' });
        expect(hook.getCurrent().url).toBe('https://preview.example.test/docs?x=1&previewToken=fresh-server-admission#heading');
        await hook.rerender({ ...baseInput, serverId, fallbackUrl: `${fallbackUrl}?previewToken=fallback-admission`, requestedUrl: 'https://preview.example.test/docs?x=1#heading' });
        expect(hook.getCurrent().url).toBe('https://preview.example.test/docs?x=1&previewToken=fresh-server-admission#heading');
        await hook.rerender({ ...baseInput, serverId, fallbackUrl: `${fallbackUrl}?previewToken=fallback-admission`, requestedUrl: 'http://127.0.0.1:42123/docs?x=1#heading' });
        const nativeDefault = boundaries.invoke.getMockImplementation()!;
        boundaries.invoke.mockImplementation((command, args) => command === 'iroh_start_machine_tunnel'
            ? Promise.resolve({ leaseId: 'resumed-lease', localPort: 42124 }) : nativeDefault(command, args));
        await act(async () => { storage.setState((state) => ({ localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'automatic' } })); });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().url).toBe('http://127.0.0.1:42124/docs?x=1#heading');
        const proofs = boundaries.fetch.mock.calls.filter(([url, init]) => url.includes('/access') && !isServerAccessCall(init)).map(([, init]) => JSON.parse(String(init?.body)).ephemeralPublicKeyBase64Url);
        expect(proofs).toHaveLength(2);
        expect(proofs[0]).not.toBe(proofs[1]);
        await hook.unmount();
    });

    it('refuses another preview identity and falls back on network denial', async () => {
        boundaries.fetch.mockImplementation(async (url, init) => url.includes('/access')
            ? Response.json({ ...accessResponse(JSON.parse(String(init?.body))), previewId: 'other-preview' })
            : Response.json({ ok: true }));
        expect(await acquireNativeDirectPreviewAccess({ previewId: 'preview-1', machineId: 'machine-1', serverId })).toBeNull();
        expect(boundaries.invoke.mock.calls.some(([command]) => command === 'iroh_start_machine_tunnel')).toBe(false);
        boundaries.fetch.mockImplementation(async () => Response.json({ error: 'preview_access_denied' }, { status: 403 }));
        const hook = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId } });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent()).toMatchObject({ url: null, localOrigin: null, acquiring: false });
        await hook.unmount();
    });

    it('keeps the reserved preview admission query out of signed initial native navigation', async () => {
        boundaries.fetch.mockImplementation(async (url, init) => url.includes('/access')
            ? Response.json({ ...accessResponse(JSON.parse(String(init?.body))), initialPath: { pathname: '/start', search: '?previewToken=server-secret&app=1' } })
            : Response.json({ ok: true }));
        const hook = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId } });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().url).toBe('http://127.0.0.1:42123/start?app=1');
        await hook.unmount();
    });

    it('honors the captured Account and Machine direct preferences rather than the focused Account', async () => {
        const scope = { serverId, accountId: 'viewer-account' };
        const off = withDirectConnectionsEnabled(settingsDefaults.peerMediationPreferencesV1, false);
        storage.setState({ settingsScope: { serverId, accountId: 'another-account' }, settings: settingsDefaults });
        saveAccountSettings(scope, { ...settingsDefaults, peerMediationPreferencesV1: off }, 1);
        expect(await acquireNativeDirectPreviewAccess({ previewId: 'preview-1', machineId: 'machine-1', serverId })).toBeNull();
        expect(boundaries.fetch.mock.calls.some(([url]) => url.includes('/access'))).toBe(false);

        // The canonical fold permits the explicit Machine choice to override its Account default.
        saveAccountSettings(scope, { ...settingsDefaults, peerMediationPreferencesV1: withMachineDirectConnectionChoice(off, 'machine-1', 'direct') }, 2);
        storage.setState({ settings: { ...settingsDefaults, peerMediationPreferencesV1: off } });
        const lease = await acquireNativeDirectPreviewAccess({ previewId: 'preview-1', machineId: 'machine-1', serverId });
        expect(lease?.localOrigin).toBe('http://127.0.0.1:42123');
        await lease?.release();
    });

    it('rechecks the same captured Account preference after access arrives and before native dialing', async () => {
        const issued = createDeferred<Record<string, unknown>>();
        const pending = createDeferred<Response>();
        boundaries.fetch.mockImplementation((url, init) => {
            if (!url.includes('/access')) return Promise.resolve(Response.json({ ok: true }));
            issued.resolve(JSON.parse(String(init?.body)));
            return pending.promise;
        });
        storage.setState({ settingsScope: { serverId, accountId: 'another-account' }, settings: settingsDefaults });
        const acquisition = acquireNativeDirectPreviewAccess({ previewId: 'preview-1', machineId: 'machine-1', serverId });
        const request = await issued.promise;
        saveAccountSettings({ serverId, accountId: 'viewer-account' }, {
            ...settingsDefaults,
            peerMediationPreferencesV1: withDirectConnectionsEnabled(settingsDefaults.peerMediationPreferencesV1, false),
        }, 2);
        pending.resolve(Response.json(accessResponse(request)));
        expect(await acquisition).toBeNull();
        expect(boundaries.invoke.mock.calls.some(([command]) => command === 'iroh_start_machine_tunnel')).toBe(false);
    });

    it('refreshes expired server admission once when a native-first viewer resumes without native availability', async () => {
        const input: NativeDirectPreviewInput = { ...baseInput, serverId, fallbackUrl: `${fallbackUrl}?previewToken=expired-admission` };
        const hook = await renderHook(useNativeDirectPreview, { initialProps: input });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().url).toBe('http://127.0.0.1:42123/start');
        expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(false);
        await hook.rerender({ ...input, enabled: false, requestedUrl: 'http://127.0.0.1:42123/docs?app=1#heading' });
        await flushHookEffects();
        expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(false);
        const nativeDefault = boundaries.invoke.getMockImplementation()!;
        boundaries.invoke.mockImplementation((command, args) => command === 'iroh_get_availability'
            ? Promise.resolve({ available: false }) : nativeDefault(command, args));
        await hook.rerender({ ...input, requestedUrl: 'http://127.0.0.1:42123/docs?app=1#heading' });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent()).toMatchObject({ url: 'https://preview.example.test/docs?app=1&previewToken=fresh-server-admission#heading', acquiring: false });
        await hook.rerender({ ...input, requestedUrl: 'https://preview.example.test/next?app=2#next', fallbackUrl: `${fallbackUrl}?previewToken=another-stale-row` });
        expect(hook.getCurrent().url).toBe('https://preview.example.test/next?app=2&previewToken=fresh-server-admission#next');
        const serverCalls = boundaries.fetch.mock.calls.filter(([url, init]) => url.includes('/access') && isServerAccessCall(init));
        expect(serverCalls).toHaveLength(1);
        expect(serverCalls[0]?.[1]?.method).toBe('POST');
        expect(new Headers(serverCalls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature');
        await hook.unmount();
    });

    it('aborts pending server fallback and ignores a late result after the viewer is suspended', async () => {
        const input: NativeDirectPreviewInput = { ...baseInput, serverId, fallbackUrl: `${fallbackUrl}?previewToken=expired-admission` };
        const hook = await renderHook(useNativeDirectPreview, { initialProps: input });
        await flushHookEffects({ cycles: 40 });
        const issued = createDeferred<RequestInit>();
        const pending = createDeferred<Response>();
        const networkDefault = boundaries.fetch.getMockImplementation()!;
        boundaries.fetch.mockImplementation((url, init) => {
            if (!url.includes('/access') || !isServerAccessCall(init)) return networkDefault(url, init);
            issued.resolve(init ?? {});
            return pending.promise;
        });
        await act(async () => { storage.setState((state) => ({ localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'standard_only' } })); });
        await flushHookEffects({ cycles: 40 });
        expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(true);
        const request = await issued.promise;
        expect(hook.getCurrent()).toMatchObject({ url: null, acquiring: true });
        await hook.rerender({ ...input, enabled: false });
        expect(request.signal?.aborted).toBe(true);
        await act(async () => { pending.resolve(Response.json(serverAccessResponse('cancelled-admission'))); });
        await flushHookEffects();
        expect(hook.getCurrent().url).not.toContain('cancelled-admission');
        await hook.unmount();
    });

    it('keeps server fallback tied to the native viewer requester Account when Home credentials change', async () => {
        const hook = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId } });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().localOrigin).toBe('http://127.0.0.1:42123');
        boundaries.credentialsToken = `header.${Buffer.from(JSON.stringify({ sub: 'another-account' })).toString('base64url')}.signature`;
        await act(async () => { storage.setState((state) => ({ localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'standard_only' } })); });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent()).toMatchObject({ url: null, acquiring: false });
        expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(false);
        await hook.unmount();

        boundaries.credentialsToken = 'header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature';
        storage.setState((state) => ({ localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'automatic' } }));
        const networkDefault = boundaries.fetch.getMockImplementation()!;
        boundaries.fetch.mockImplementation((url, init) => {
            if (!url.includes('/access') || isServerAccessCall(init)) return networkDefault(url, init);
            // Even a denied native attempt has captured its requester before the response.
            boundaries.credentialsToken = `header.${Buffer.from(JSON.stringify({ sub: 'another-account' })).toString('base64url')}.signature`;
            return Promise.resolve(Response.json({ error: 'preview_transport_unavailable' }, { status: 503 }));
        });
        const denied = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId } });
        await flushHookEffects({ cycles: 40 });
        expect(denied.getCurrent()).toMatchObject({ url: null, acquiring: false });
        expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(false);
        await denied.unmount();
    });

    it('refreshes plain web admission but leaves disabled and explicit external navigation alone', async () => {
        const input: NativeDirectPreviewInput = { ...baseInput, serverId, enabled: false };
        const hook = await renderHook(useNativeDirectPreview, { initialProps: input });
        await flushHookEffects();
        expect(hook.getCurrent().url).toBe(fallbackUrl);
        await act(async () => {
            storage.setState((state) => ({ localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'standard_only' } }));
        });
        await hook.rerender({ ...input, enabled: true, requestedUrl: 'https://external.example.test/docs' });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().url).toBe('https://external.example.test/docs');
        expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(false);
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        await hook.rerender({ ...input, enabled: true });
        await flushHookEffects({ cycles: 40 });
        expect(hook.getCurrent().url).toBe(`${fallbackUrl}?previewToken=fresh-server-admission`);
        await hook.unmount();
    });

    it('does not refresh admission while the native application is inactive', async () => {
        boundaries.platformOS = 'ios';
        boundaries.appState = 'background';
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        storage.setState((state) => ({ localSettings: { ...state.localSettings, homeApplicationCarrierEligibility: 'standard_only' } }));
        const hook = await renderHook(useNativeDirectPreview, { initialProps: { ...baseInput, serverId } });
        await flushHookEffects({ cycles: 40 });
        expect(boundaries.fetch.mock.calls.some(([, init]) => isServerAccessCall(init))).toBe(false);
        await hook.unmount();
    });

    it('consumed BrowserViewHost owns native preview leases by logical view lifetime without an isolated server route', async () => {
        const { BrowserViewHost } = await import('@/components/browser/BrowserViewHost');
        const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
        const { applyLocalServicePreviewSnapshot, createLocalServicePreviewState } = await import('./store');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const target = { kind: 'localServicePreview', targetId: 'preview-1', machineId: 'machine-1', display: { title: 'Preview' } } as const;
        const view: BrowserControlViewState = {
            browserSessionId: 'browser-session-1', viewId: 'preview-view-1', target,
            platform: 'desktop', adapterKind: 'localPreview', engineKind: 'desktopWebView',
            adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'localPreview', supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['desktopWebView'], desktopWebViewSupport: desktopAvailability.supports }),
            currentUrl: null, currentUrlExpiresAt: null, pendingUrl: null, title: 'Preview', faviconUrl: null,
            loadingState: 'idle', loadingProgress: null, navigationGeneration: 0, canGoBack: false, canGoForward: false,
            securityOrigin: null, lastError: null, openerViewId: null, adapterRefreshStatus: 'idle', adapterRefreshError: null,
        };
        const snapshot = {
            generatedAt: 1, refreshState: 'idle' as const, diagnostics: [], previews: [{
                previewId: 'preview-1', accessUrl: null, expiresAt: null, diagnostics: [],
                accessUnavailableReasonCode: 'preview_private_route_unavailable' as const,
                nativeDirect: { v: 1, kind: 'iroh_preview', previewId: 'preview-1', machineId: 'machine-1' } as const,
                resource: {
                    previewId: 'preview-1', machineId: 'machine-1', owner: { kind: 'user', id: 'owner-account' } as const,
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 } as const, initialPath: { pathname: '/start', search: '' },
                    display: { title: 'Preview', addressLabel: 'localhost:5173' }, originMode: 'host' as const, browserTarget: target,
                },
            }],
        };
        const localServicePreviewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), snapshot);
        const props = {
            view, localServicePreviewState, localServicePreviewServerId: serverId, testID: 'native-preview',
            browserProfile: { profileId: 'profile-1', storageMode: 'user', owner: { kind: 'user', id: 'viewer-account' }, cleanupOnSessionClose: true } as const,
        };
        const screen = await renderScreen(React.createElement(BrowserViewHost, props));
        await flushHookEffects({ cycles: 40 });
        expect(boundaries.fetch.mock.calls.some(([url]) => url.endsWith('/v1/local-services/preview/preview-1/access'))).toBe(true);
        const opened = boundaries.invoke.mock.calls.find(([command]) => command === 'desktop_browser_open_view');
        expect(JSON.stringify(opened?.[1])).toContain('http://127.0.0.1:42123/start');
        expect(screen.tree.findAllHostsByTestId('native-preview-elsewhere')).toHaveLength(0);
        const nativeDefault = boundaries.invoke.getMockImplementation()!;
        let nextLease = 1;
        boundaries.invoke.mockImplementation((command, args) => {
            if (command !== 'iroh_start_machine_tunnel') return nativeDefault(command, args);
            nextLease += 1;
            return Promise.resolve({ leaseId: `lease-${nextLease}`, localPort: 42122 + nextLease });
        });
        await screen.update(React.createElement(BrowserViewHost, { ...props, lifecycleState: 'suspended' }));
        await flushHookEffects();
        expect(boundaries.invoke.mock.calls).toContainEqual(['iroh_stop_machine_tunnel', { leaseId: 'lease-1' }]);
        await screen.update(React.createElement(BrowserViewHost, props));
        await flushHookEffects({ cycles: 40 });
        const nextView = { ...view, viewId: 'preview-view-2' };
        await screen.update(React.createElement(BrowserViewHost, { ...props, view: nextView }));
        await flushHookEffects({ cycles: 40 });
        expect(boundaries.invoke.mock.calls.filter(([command]) => command === 'iroh_stop_machine_tunnel')
            .map(([, args]) => args?.leaseId)).toContain('lease-2');
        const nextOpened = boundaries.invoke.mock.calls.find(([command, args]) => command === 'desktop_browser_open_view'
            && JSON.stringify(args).includes('preview-view-2'));
        expect(JSON.stringify(nextOpened?.[1])).toContain('http://127.0.0.1:42125/start');
        const proofs = boundaries.fetch.mock.calls.filter(([url]) => url.includes('/access')).map(([, init]) => JSON.parse(String(init?.body)).ephemeralPublicKeyBase64Url);
        expect(proofs).toHaveLength(3);
        expect(new Set(proofs).size).toBe(3);
        await screen.unmount();
        await flushHookEffects();
        expect(boundaries.invoke.mock.calls).toContainEqual(['iroh_stop_machine_tunnel', { leaseId: 'lease-3' }]);
    });
});
