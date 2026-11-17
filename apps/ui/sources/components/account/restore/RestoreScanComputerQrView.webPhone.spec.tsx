import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { HomeQrInviteV2Schema, HomeQrPairingStatusV2Schema, computeHomeQrBindingProofV2,
    createHomeQrReverseInviteV2, deriveHomeQrBindingKeyV2, deriveHomeQrRendezvousSecretV2,
    type HomeQrInviteV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests, createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { installBrowserIrohSharedWorkerBoundary } from '@/dev/testkit/mocks/browserIrohSharedWorker';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

const boundary = vi.hoisted(() => ({
    focused: true, replace: vi.fn(), preventRemove: vi.fn(), alert: vi.fn(async (..._args: unknown[]) => {}),
    restored: vi.fn(), retried: vi.fn(), permission: { granted: true, status: 'granted', canAskAgain: true, expires: 'never' },
    requestPermission: vi.fn(async () => ({ granted: true })),
}));
installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('restore_scan_web_phone', { preserveGenerations: true });
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ router: { replace: boundary.replace } }).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ spies: { alertAsync: (...args) => boundary.alert(...args) } }).module);
vi.mock('@react-navigation/native', async () => ({ ...(await import('@/dev/testkit/mocks/reactNavigation'))
    .createReactNavigationNativeMock({ usePreventRemove: locked => boundary.preventRemove(locked) }),
    useIsFocused: () => boundary.focused }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
// Native camera SDK only: scanner permission, deduplication and restore routing remain real.
vi.mock('expo-camera', () => ({ CameraView: 'CameraView',
    useCameraPermissions: () => [boundary.permission, boundary.requestPermission] }));
// test-policy-boundary: analytics emits to an external telemetry service.
vi.mock('@/track', async importOriginal => ({ ...await importOriginal<typeof import('@/track')>(),
    trackAccountRestored: boundary.restored, trackAuthEnrollmentTransientRetry: boundary.retried }));

await initializeRealAppRuntimeForTests();
const profiles = await import('@/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { buildHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
const { encryptBox } = await import('@/encryption/libsodium');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');
const { QrCodeScannerView } = await import('@/components/qr/QrCodeScannerView');

const home = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_home_b',
    canonicalServerUrl: 'https://home-b.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home-b.test' }] });
const homes = createHomeGovernanceHarness();
const enrolledToken = createAccountTokenForTests('enrolled-home-b');
type HttpRequest = Readonly<{ url: URL; body: Record<string, unknown>; token: string | null; signal?: AbortSignal | null }>;
type HttpReply = (request: HttpRequest) => Response | Promise<Response>;
const requests: HttpRequest[] = [];
const http = { features: vi.fn<HttpReply>(), register: vi.fn<HttpReply>(), request: vi.fn<HttpReply>(),
    poll: vi.fn<HttpReply>(), start: vi.fn<HttpReply>(), status: vi.fn<HttpReply>(), complete: vi.fn<HttpReply>() };
let localStorage: ReturnType<typeof installLocalStorageMock>;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let focusedHomeId = '';
let targetHomeId = '';
let features = createRootLayoutFeaturesResponse();
let activeInvite: HomeQrInviteV2;
const holds: Array<ReturnType<typeof createDeferred<Response>>> = [];
function hold() { const result = createDeferred<Response>(); holds.push(result); return result; }
function observed(path: string) { return requests.filter(request => request.url.pathname === path); }
function forwardInvite() {
    return HomeQrInviteV2Schema.parse({ v: 2, intent: 'home_device', direction: 'trusted_home_displays', pairId: 'pair-b',
        home, qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
        issuedAtMs: Date.now() - 1_000, expiresAtMs: Date.now() + 120_000 });
}
function reverseInvite() { return createHomeQrReverseInviteV2({ home, nowMs: Date.now() }).invite; }
function authorized(request: HttpRequest, token = enrolledToken) {
    const publicKey = decodeBase64(String(request.body.publicKey));
    return Response.json({ state: 'authorized', tokenEncrypted: encodeBase64(encryptBox(new TextEncoder().encode(token), publicKey)),
        response: encodeBase64(sealTerminalProvisioningV3TokenOnlyPayload({ terminalEphemeralPublicKey: publicKey,
            pairingSecret: deriveHomeQrBindingKeyV2(decodeBase64(activeInvite.qrSecretBase64Url, 'base64url')),
            createdAtMs: activeInvite.issuedAtMs, expiresAtMs: activeInvite.expiresAtMs, randomBytes: tweetnacl.randomBytes })) });
}
function requestedStatus() {
    if (activeInvite.direction !== 'requester_displays') throw new Error('Expected requester-displayed invite');
    const publicKey = decodeBase64(activeInvite.requesterPublicKeyBase64Url, 'base64url');
    return HomeQrPairingStatusV2Schema.parse({ state: 'requested', pairId: activeInvite.pairId,
        expiresAt: new Date(activeInvite.expiresAtMs).toISOString(), requestedPublicKey: encodeBase64(publicKey),
        requestedDeviceLabel: null, homeServerIdentityId: home.homeServerIdentityId,
        bindingProof: computeHomeQrBindingProofV2({ direction: activeInvite.direction,
            qrSecret: decodeBase64(activeInvite.qrSecretBase64Url, 'base64url'), pairId: activeInvite.pairId,
            homeServerIdentityId: home.homeServerIdentityId, requesterPublicKey: publicKey, expiresAtMs: activeInvite.expiresAtMs }) });
}
async function trustTargetHome() {
    await TokenStorage.setCredentialsForServerUrl(home.canonicalServerUrl, { serverId: targetHomeId },
        { token: createAccountTokenForTests('trusted-home-b') });
}
async function mount(props: Partial<React.ComponentProps<typeof RestoreScanComputerQrView>> = {}) {
    return renderScreen(<AuthProvider initialCredentials={null}>
        <RestoreScanComputerQrView entryIntent="add_home" {...props} />
    </AuthProvider>);
}
function cameraScan(screen: Awaited<ReturnType<typeof mount>>, value: string) {
    return screen.findByType('CameraView').props.onBarcodeScanned({ type: 'qr', data: value }) as Promise<void>;
}
async function scan(screen: Awaited<ReturnType<typeof mount>>, invite = forwardInvite()) {
    activeInvite = invite;
    await act(async () => { await cameraScan(screen, buildHomeQrInviteDeepLink({ invite })); });
}
async function beginScan(screen: Awaited<ReturnType<typeof mount>>, invite = forwardInvite()) {
    activeInvite = invite;
    let completion!: Promise<void>;
    await act(async () => { completion = cameraScan(screen, buildHomeQrInviteDeepLink({ invite })); });
    return { completion };
}
async function expectNoAdoption() {
    expect(await TokenStorage.getCredentialsForServerUrl(home.canonicalServerUrl, { serverId: targetHomeId })).toBeNull();
    expect(boundary.replace).not.toHaveBeenCalled();
    expect(profiles.getActiveServerSnapshot().serverId).toBe(focusedHomeId);
}

beforeEach(async () => {
    vi.useRealTimers();
    browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev/restore' });
    localStorage = installLocalStorageMock();
    await homes.reset(); resetServerFeaturesClientForTests();
    boundary.focused = true;
    for (const spy of [boundary.replace, boundary.preventRemove, boundary.restored, boundary.retried]) spy.mockClear();
    boundary.alert.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
    focusedHomeId = await homes.addHome({ name: 'Focused Home A', serverUrl: 'https://home-a.test' });
    targetHomeId = await homes.addHome({ name: 'Home B', serverUrl: home.canonicalServerUrl,
        serverIdentityId: home.homeServerIdentityId, active: false, accountId: 'enrolled-home-b' });
    targetHomeId = (await profiles.adoptHomeProfile({ descriptor: home, source: 'manual',
        descriptorAuthority: 'current_connection_observation' })).id;
    // The server Account exists; this device has not enrolled into it yet.
    await TokenStorage.removeCredentialsForServerUrl(home.canonicalServerUrl, { serverId: targetHomeId });
    features = createRootLayoutFeaturesResponse();
    features.capabilities.serverIdentity.serverIdentityId = home.homeServerIdentityId;
    features.capabilities.server.canonicalServerUrl = home.canonicalServerUrl;
    tryWriteServerEnabledBitInPlace(features, 'auth.pairing.desktopQrMobileScan', true);
    tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true);
    activeInvite = forwardInvite(); requests.length = 0;
    http.features.mockReset().mockImplementation(() => Response.json(features));
    http.register.mockReset().mockImplementation(() => Response.json({ state: 'requested' }));
    http.request.mockReset().mockImplementation(() => Response.json({ state: 'requested' }));
    http.poll.mockReset().mockImplementation(request => authorized(request));
    http.start.mockReset().mockImplementation(() => Response.json({ pairId: activeInvite.pairId, expiresAt: new Date(activeInvite.expiresAtMs).toISOString() }));
    http.status.mockReset().mockImplementation(() => Response.json(requestedStatus()));
    http.complete.mockReset().mockImplementation(() => Response.json({}));
    setRuntimeFetch(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== home.canonicalServerUrl) return homes.request(input, init);
        const bearer = new Headers(init?.headers).get('Authorization');
        const request: HttpRequest = { url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
            token: bearer?.startsWith('Bearer ') ? bearer.slice(7) : null, signal: init?.signal };
        requests.push(request);
        let handler: HttpReply | undefined;
        if (url.pathname === '/v1/features') handler = http.features;
        if (url.pathname === '/v2/auth/account/request') handler = 'pairId' in request.body ? http.poll : http.register;
        if (url.pathname === '/v1/auth/pairing/request') handler = http.request;
        if (url.pathname === '/v1/auth/pairing/start') handler = http.start;
        if (url.pathname === '/v1/auth/pairing/status') handler = http.status;
        if (url.pathname === '/v1/auth/account/response') handler = http.complete;
        if (url.pathname === '/v1/auth/pairing/consume') return Response.json({});
        return handler ? await waitForNetworkResponseForTests(Promise.resolve(handler(request)), init?.signal) : homes.request(input, init);
    });
});
afterEach(async () => {
    await standardCleanup();
    for (const held of holds.splice(0)) held.resolve(Response.json({}, { status: 410 }));
    await flushHookEffects();
    await disconnectActiveServerConnection();
    vi.useRealTimers(); await homes.reset(); localStorage.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); browser.restore();
});

describe('RestoreScanComputerQrView (web phone)', () => {
    it('renders the real scanner and keeps pairing-link entry reachable on web', async () => {
        const onOpenPairingLinkEntry = vi.fn();
        const screen = await mount({ onOpenPairingLinkEntry });
        expect(screen.findByType('CameraView')).toBeTruthy();
        expect(screen.findByTestId('restore-open-manual')).not.toBeNull();
        expect(screen.findByTestId('restore-show-qr-instead')).toBeNull();
        expect(screen.findByTestId('restore-pairing-link-details')).toBeNull();
        await screen.pressByTestIdAsync('restore-enter-pairing-link');
        expect(onOpenPairingLinkEntry).toHaveBeenCalledOnce();
    });
    it('does not let focused Home A disable scanning a feature-enabled Home B invite', async () => {
        // Home A's real default feature catalog disables QR pairing.
        const screen = await mount();
        await scan(screen);
        expect(screen.getTextContent()).toContain('connect.homeAddedPreservedFocusBody');
    });
    it('fails closed against the parsed target Home when that Home disables QR enrollment', async () => {
        tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', false);
        const screen = await mount(); await scan(screen);
        expect(observed('/v2/auth/account/request')).toHaveLength(0);
        expect(observed('/v1/auth/pairing/request')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('connect.updateRequiredBody');
        expect(screen.findByTestId('restore-enrollment-retry')).toBeNull();
        await expectNoAdoption();
    });
    it('retries transient browser-Iroh setup and probes the exact Home through its real semantic carrier', async () => {
        vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
        vi.stubGlobal('location', { origin: 'https://app.test', href: 'https://app.test/restore' });
        const descriptor = HomeConnectionDescriptorV1Schema.parse({ ...home, revision: 2,
            endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.test/'] }] });
        tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', false);
        let featureFailures = 1;
        const worker = installBrowserIrohSharedWorkerBoundary({ acquireFailures: 1, respond: () => {
            if (featureFailures-- > 0) return Response.json({}, { status: 503 });
            return Response.json(features);
        } });
        const screen = await mount();
        const { completion } = await beginScan(screen, HomeQrInviteV2Schema.parse({ ...forwardInvite(), home: descriptor }));
        await vi.waitFor(() => expect(worker.commands.some(command => command.kind === 'acquireLease')).toBe(true));
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); await completion; });
        expect(worker.commands.filter(command => command.kind === 'acquireLease')).toHaveLength(2);
        expect(worker.commands.some(command => command.kind === 'openStream' && command.endpointId === 'a'.repeat(64))).toBe(true);
        expect(worker.writtenRequests().some(request => request.startsWith('GET /v1/features HTTP/1.1'))).toBe(true);
        expect(observed('/v1/features')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('connect.updateRequiredBody');
    });
    it('marks the QR scanner inactive when the restore route is covered by another screen', async () => {
        boundary.focused = false;
        const screen = await mount();
        expect(screen.findByType(QrCodeScannerView).props.active).toBe(false);
        expect(screen.findAllByType('CameraView')).toHaveLength(0);
    });
    it.each([true, false])('routes account-connect guidance through the embedded restore owner (alternate QR %s)', async supported => {
        const onShowQrInstead = supported ? vi.fn() : undefined;
        if (supported) boundary.alert.mockImplementationOnce(async (...args: unknown[]) => {
            (args[2] as Array<{ text?: string; onPress?: () => void }>).find(button => button.text === 'connect.showQrInstead')?.onPress?.();
        });
        const screen = await mount({ embedded: true, onShowQrInstead });
        await act(async () => { await cameraScan(screen, 'happier:///account?abc123'); });
        expect(observed('/v1/auth/pairing/start')).toHaveLength(0);
        expect(boundary.alert).toHaveBeenCalled();
        if (supported) expect(onShowQrInstead).toHaveBeenCalledOnce();
        else expect(boundary.alert.mock.calls[0]?.[2]).toEqual([{ text: 'common.ok' }]);
    });
    it('enrolls the exact V2 Home without an advisory descriptor or focused login', async () => {
        const screen = await mount(); await scan(screen);
        const request = observed('/v1/auth/pairing/request')[0]!;
        expect(request.body).toMatchObject({ pairId: 'pair-b', homeServerIdentityId: home.homeServerIdentityId,
            secret: encodeBase64(deriveHomeQrRendezvousSecretV2(new Uint8Array(32).fill(4)), 'base64url') });
        expect(request.token).toBeNull();
        expect(await TokenStorage.getCredentialsForServerUrl(home.canonicalServerUrl, { serverId: targetHomeId })).toEqual({ token: enrolledToken });
        expect(profiles.getServerProfileById(targetHomeId)?.serverIdentityId).toBe(home.homeServerIdentityId);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focusedHomeId);
        expect(boundary.restored).toHaveBeenCalledOnce();
        expect(screen.getTextContent()).toContain('connect.homeAddedPreservedFocusBody');
        expect(screen.getTextContent()).toContain('home-b.test');
        expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
        expect(boundary.alert).not.toHaveBeenCalled();
    });
    it('ignores an advisory descriptor retarget and persists the exact V2 invite Home', async () => {
        http.features.mockImplementation(() => Response.json({ ...features, homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({
            ...home, canonicalServerUrl: 'https://retarget.test', endpoints: [{ kind: 'https', url: 'https://retarget.test' }], revision: 2,
        }) }));
        const screen = await mount(); await scan(screen);
        expect(profiles.getServerProfileById(targetHomeId)?.serverUrl).toBe(home.canonicalServerUrl);
        expect(await TokenStorage.getCredentialsForServerUrl(home.canonicalServerUrl, { serverId: targetHomeId })).toEqual({ token: enrolledToken });
        expect(requests.every(request => request.url.origin === home.canonicalServerUrl)).toBe(true);
    });
    it('completes a known-target requester invite through its stored Home and real sealed response', async () => {
        await trustTargetHome(); const invite = reverseInvite();
        const onInviteDirectionChange = vi.fn();
        const screen = await mount({ onInviteDirectionChange }); await scan(screen, invite);
        expect(onInviteDirectionChange).toHaveBeenCalledWith('requester_displays');
        expect(observed('/v1/auth/pairing/start')[0]?.body).toMatchObject({ direction: 'requester_displays', pairId: invite.pairId });
        expect(observed('/v1/auth/account/response')[0]?.body).toMatchObject({ pairId: invite.pairId,
            homeServerIdentityId: home.homeServerIdentityId, responseKind: 'tokenOnly', response: expect.any(String) });
        expect(observed('/v1/auth/account/response')[0]?.token).toBe(createAccountTokenForTests('trusted-home-b'));
        expect(observed('/v2/auth/account/request')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('connect.requesterDeviceAddedBody');
        expect(screen.findByTestId('restore-scan-confirm-code')).toBeNull();
        expect(screen.getTextContent()).not.toContain('connect.confirmCodeComparisonBody');
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focusedHomeId);
    });
    it('reports reverse-direction success once after a transient status failure', async () => {
        await trustTargetHome(); vi.useFakeTimers();
        http.status.mockImplementationOnce(() => Response.json({}, { status: 503 }));
        const screen = await mount(); const { completion } = await beginScan(screen, reverseInvite());
        await vi.waitFor(() => expect(http.status).toHaveBeenCalled());
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); await completion; });
        expect(screen.getTextContent()).toContain('connect.requesterDeviceAddedBody');
        expect(observed('/v1/auth/account/response')).toHaveLength(1);
    });
    it('does not dispatch reverse completion UI after unmount', async () => {
        await trustTargetHome(); const held = hold(); http.complete.mockImplementation(() => held.promise);
        const screen = await mount(); const { completion } = await beginScan(screen, reverseInvite());
        await vi.waitFor(() => expect(http.complete).toHaveBeenCalled());
        await screen.unmount(); held.resolve(Response.json({})); await completion;
        expect(boundary.alert).not.toHaveBeenCalled(); expect(boundary.replace).not.toHaveBeenCalled();
    });
    it.each(['cancel', 'unmount'] as const)('aborts reverse polling and consumes its exact pending row on %s', async action => {
        await trustTargetHome(); const held = hold(); http.status.mockImplementation(() => held.promise);
        const screen = await mount(); const invite = reverseInvite(); const { completion } = await beginScan(screen, invite);
        await vi.waitFor(() => expect(http.status).toHaveBeenCalled());
        const signal = http.status.mock.calls[0]![0].signal;
        if (action === 'cancel') await screen.pressByTestIdAsync('restore-enrollment-cancel'); else await screen.unmount();
        await vi.waitFor(() => expect(observed('/v1/auth/pairing/consume')[0]?.body).toEqual({ pairId: invite.pairId, intent: 'cancel' }));
        expect(signal?.aborted).toBe(true);
        held.resolve(Response.json(requestedStatus())); await completion;
        expect(observed('/v1/auth/account/response')).toHaveLength(0);
        expect(boundary.replace).not.toHaveBeenCalled();
    });
    it('aborts reverse start and consumes the row when cancellation races its response', async () => {
        await trustTargetHome(); const held = hold(); http.start.mockImplementation(() => held.promise);
        const screen = await mount(); const invite = reverseInvite(); const { completion } = await beginScan(screen, invite);
        await vi.waitFor(() => expect(http.start).toHaveBeenCalled());
        const signal = http.start.mock.calls[0]![0].signal;
        await screen.pressByTestIdAsync('restore-enrollment-cancel');
        held.resolve(Response.json({ pairId: invite.pairId, expiresAt: new Date(invite.expiresAtMs).toISOString() })); await completion;
        expect(signal?.aborted).toBe(true);
        expect(observed('/v1/auth/pairing/consume')[0]?.body).toEqual({ pairId: invite.pairId, intent: 'cancel' });
        expect(observed('/v1/auth/account/response')).toHaveLength(0);
    });
    it('retries transient initial auth and bound-request failures with the same key and proof', async () => {
        vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
        http.register.mockImplementationOnce(() => Response.json({}, { status: 503 }));
        http.request.mockImplementationOnce(() => Response.json({}, { status: 503 }));
        const screen = await mount(); const { completion } = await beginScan(screen);
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); await completion; });
        expect(http.register.mock.calls.map(([request]) => request.body.publicKey)).toEqual([expect.any(String), http.register.mock.calls[0]![0].body.publicKey]);
        expect(http.request.mock.calls[1]?.[0].body).toEqual(http.request.mock.calls[0]?.[0].body);
        expect(screen.getTextContent()).toContain('connect.homeAddedPreservedFocusBody');
    });
    it('retries a transient target feature request until the exact invite succeeds', async () => {
        vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
        http.features.mockImplementationOnce(() => { throw new TypeError('Network disconnected'); });
        const screen = await mount(); const { completion } = await beginScan(screen);
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); await completion; });
        expect(observed('/v1/auth/pairing/request')[0]?.body.pairId).toBe('pair-b');
        expect(screen.getTextContent()).toContain('connect.homeAddedPreservedFocusBody');
    });
    it.each(['saved_identity_conflict', 'invite_identity_mismatch', 'invalid_payload'] as const)('fails closed against the real %s feature payload', async failure => {
        // With no saved identity, the response is valid but disagrees with the invite;
        // a saved Home instead makes the real profile owner refuse identity learning.
        if (failure === 'invite_identity_mismatch') await profiles.removeServerProfile(targetHomeId);
        http.features.mockImplementation(() => Response.json(failure === 'invalid_payload' ? { invalid: true }
            : { ...features, capabilities: { ...features.capabilities, serverIdentity: { serverIdentityId: 'srv_other' } } }));
        const screen = await mount(); await scan(screen);
        expect(screen.getTextContent()).toContain(failure === 'invalid_payload' ? 'connect.updateRequiredBody' : 'connect.wrongHomeBody');
        expect(screen.findByTestId('restore-enrollment-retry') === null).toBe(failure === 'invalid_payload');
        expect(boundary.alert).not.toHaveBeenCalled();
        expect(observed('/v1/auth/pairing/request')).toHaveLength(0); await expectNoAdoption();
    });
    it.each(['network', 'invalid_payload', 'bad_request'] as const)('classifies the saved reverse Home feature %s response', async failure => {
        await trustTargetHome();
        const screen = await mount();
        http.features.mockImplementation(() => {
            if (failure === 'network') throw new TypeError('Network disconnected');
            return failure === 'bad_request' ? Response.json({}, { status: 400 }) : Response.json({ invalid: true });
        });
        await scan(screen, reverseInvite());
        expect(screen.getTextContent()).toContain(failure === 'invalid_payload' ? 'connect.updateRequiredBody'
            : failure === 'bad_request' ? 'connect.requesterDeviceRequestInvalidBody' : 'connect.requesterDeviceRetryBody');
        expect(observed('/v1/auth/pairing/start')).toHaveLength(0);
        expect(screen.findByTestId('restore-enrollment-retry') !== null).toBe(failure !== 'invalid_payload');
    });
    it('does not retry a bad-request feature response on a forward QR invite', async () => {
        http.features.mockImplementation(() => Response.json({}, { status: 400 }));
        const screen = await mount(); await scan(screen);
        expect(http.features).toHaveBeenCalledOnce(); expect(boundary.retried).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLinkDescription');
    });
    it('waits automatically without a confirmation code and keeps status stable across poll progress', async () => {
        vi.useFakeTimers(); http.poll.mockImplementation(() => Response.json({ state: 'requested' }));
        const screen = await mount(); const { completion } = await beginScan(screen);
        await vi.waitFor(() => expect(http.poll).toHaveBeenCalled());
        const waiting = screen.getTextContent();
        expect(waiting).toContain('connect.securingCredentials');
        expect(waiting).toContain('home-b.test'); expect(waiting).toContain('connect.requestingDeviceLabel');
        expect(waiting).toContain('connect.expiresAtLabel'); expect(waiting).not.toContain('connect.confirmCodeComparisonBody');
        expect(waiting).toMatch(/common\.homeProductName\b/);
        expect(waiting).not.toMatch(/common\.home\b/);
        expect(waiting).not.toContain('connect.waitingForApproval');
        expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'polite')).toHaveLength(1);
        expect(screen.findByTestId('restore-scan-confirm-code')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(http.poll.mock.calls.length).toBeGreaterThan(1); expect(screen.getTextContent()).toBe(waiting);
        http.poll.mockImplementation(request => authorized(request));
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await completion; });
    });
    it.each([
        ['expired', 410, {}, 'connect.pairingQrExpired'],
        ['rejected', 200, { state: 'rejected' }, 'connect.pairingRejectedBody'],
        ['wrong_target', 403, {}, 'connect.wrongHomeBody'],
        ['malformed_response', 200, { state: 'authorized', token: 'plaintext' }, 'connect.unsupportedEnrollmentResponseBody'],
    ] as const)('preserves precise guidance for the real %s auth response', async (reason, status, body, copy) => {
        http.poll.mockImplementation(() => Response.json(body, { status }));
        const screen = await mount(); await scan(screen);
        expect(screen.getTextContent()).toContain(copy);
        expect(screen.findByTestId('restore-enrollment-retry') !== null).toBe(reason !== 'expired');
        if (reason === 'expired') expect(screen.findByTestId('restore-enrollment-scan-new')).not.toBeNull();
        expect(boundary.alert).not.toHaveBeenCalled(); await expectNoAdoption();
    });
    it('cancels a pre-request attempt quietly and ignores a stale successful registration', async () => {
        const held = hold(); http.register.mockImplementation(() => held.promise);
        const screen = await mount(); const { completion } = await beginScan(screen);
        await vi.waitFor(() => expect(http.register).toHaveBeenCalled());
        await screen.pressByTestIdAsync('restore-enrollment-cancel');
        held.resolve(Response.json({ state: 'requested' })); await completion;
        expect(http.register.mock.calls[0]?.[0].signal?.aborted).toBe(true);
        expect(screen.findAllByType('CameraView')).toHaveLength(1);
        expect(observed('/v1/auth/pairing/request')).toHaveLength(0); await expectNoAdoption();
    });
    it('owns one attempt and removes cancellation from the bound request boundary', async () => {
        const held = hold(); http.request.mockImplementation(() => held.promise);
        const screen = await mount(); const handler = screen.findByType(QrCodeScannerView).props.onScan;
        const { completion } = await beginScan(screen);
        await vi.waitFor(() => expect(http.request).toHaveBeenCalled());
        await act(async () => { await handler(buildHomeQrInviteDeepLink({ invite: activeInvite })); });
        expect(http.register).toHaveBeenCalledOnce(); expect(http.request).toHaveBeenCalledOnce();
        expect(screen.findByTestId('restore-enrollment-cancel')).toBeNull();
        expect(screen.findByTestId('restore-enter-pairing-link')).toBeNull();
        expect(boundary.preventRemove).toHaveBeenLastCalledWith(true);
        held.resolve(Response.json({}, { status: 404 })); await act(async () => { await completion; });
        expect(boundary.preventRemove).toHaveBeenLastCalledWith(false);
    });
    it('makes credential adoption non-cancellable while the browser storage lock is pending', async () => {
        const held = hold(); http.poll.mockImplementation(() => held.promise);
        const screen = await mount(); const { completion } = await beginScan(screen);
        await vi.waitFor(() => expect(http.poll).toHaveBeenCalled());
        const gate = createDeferred<void>(); const requestLock = navigator.locks.request.bind(navigator.locks);
        vi.spyOn(navigator.locks, 'request').mockImplementation(async (...args: Parameters<typeof navigator.locks.request>) => {
            await gate.promise; return requestLock(...args);
        });
        try {
            held.resolve(authorized(http.poll.mock.calls[0]![0]));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('connect.securingCredentials'));
            expect(screen.findByTestId('restore-enrollment-cancel')).toBeNull();
            expect(boundary.preventRemove).toHaveBeenLastCalledWith(true);
        } finally { gate.resolve(); await act(async () => { await completion; }); }
        expect(await TokenStorage.getCredentialsForServerUrl(home.canonicalServerUrl, { serverId: targetHomeId })).toEqual({ token: enrolledToken });
    });
    it.each([false, true])('opens the exact retained Home for enter_home (already focused %s)', async focused => {
        if (focused) { await profiles.setActiveServerId(targetHomeId); }
        const screen = await mount({ entryIntent: 'enter_home' }); await scan(screen);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(profiles.resolveServerProfileScopeIdForIdentifier(targetHomeId));
        expect(boundary.replace).toHaveBeenCalledWith('/');
        expect(boundary.preventRemove).toHaveBeenLastCalledWith(false);
    });
    it.each(['retry', 'return'] as const)('keeps the adopted Home after focus storage failure and allows %s', async response => {
        const setItem = browser.window.Storage.prototype.setItem; let refused = false;
        vi.spyOn(browser.window.Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
            if (key === 'activeServerId' && value === targetHomeId && (!refused || response === 'return')) { refused = true; throw new Error('Storage unavailable'); }
            setItem.call(this, key, value);
        });
        boundary.alert.mockImplementationOnce(async (...args: unknown[]) => {
            if (response === 'retry') (args[2] as Array<{ style?: string; onPress?: () => void }>).find(button => button.style !== 'cancel')?.onPress?.();
        });
        const screen = await mount({ entryIntent: 'enter_home' }); await scan(screen);
        expect(refused).toBe(true); expect(boundary.replace).toHaveBeenCalledWith('/');
        expect(profiles.getActiveServerSnapshot().serverId).toBe(response === 'retry' ? profiles.resolveServerProfileScopeIdForIdentifier(targetHomeId) : focusedHomeId);
        expect(await TokenStorage.getCredentialsForServerUrl(home.canonicalServerUrl, { serverId: targetHomeId })).toEqual({ token: enrolledToken });
    });
    it('presents target-qualified recovery after a real credential/profile partial adoption', async () => {
        const read = localStorage.setItemMock.getMockImplementation()!;
        localStorage.setItemMock.mockImplementation((key, value) => {
            read(key, value);
            if (value !== JSON.stringify({ token: enrolledToken })) return;
            const entry = [...localStorage.store].find(([key]) => key.endsWith(':server-state-v1'));
            if (!entry) throw new Error('Expected Home persistence boundary');
            const [profileStorageKey, raw] = entry;
            const persisted = JSON.parse(raw) as { servers: Record<string, { homeConnectionDescriptor?: typeof home }> };
            persisted.servers[targetHomeId]!.homeConnectionDescriptor = { ...home,
                endpoints: [...home.endpoints, { kind: 'https', url: 'https://concurrent.test' }] };
            localStorage.store.set(profileStorageKey, JSON.stringify(persisted));
            localStorage.store.set(key, JSON.stringify({ token: 'concurrent-account-token' }));
        });
        const screen = await mount(); await scan(screen);
        expect(screen.getTextContent()).toContain('connect.homeEnrollmentPartialCommitBody');
        expect(screen.getTextContent()).toContain('home-b.test');
        expect(screen.findByTestId('restore-enrollment-done')).not.toBeNull();
        expect(boundary.restored).not.toHaveBeenCalled(); expect(boundary.alert).not.toHaveBeenCalled();
    });
    it('recognizes the released V1 golden invite without enrollment side effects or secret disclosure', async () => {
        // cli-v0.2.1 commit 98ea8fb76733b1dd785d38c31360179cafa84824, also used by releasedV021.clientReaders.test.ts.
        const releasedV1Link = 'happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1';
        const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info'), vi.spyOn(console, 'error'), vi.spyOn(console, 'debug')];
        const screen = await mount(); await act(async () => { await cameraScan(screen, releasedV1Link); });
        expect(requests.filter(request => request.url.pathname.includes('/auth/') && !request.url.pathname.endsWith('/ping'))).toHaveLength(0);
        expect(boundary.alert).toHaveBeenCalledWith('connect.updateRequiredTitle', 'connect.legacyPairingUpdateRequiredBody', expect.any(Array));
        const guidance = JSON.stringify(boundary.alert.mock.calls); expect(guidance).not.toContain('sec_abc'); expect(guidance).not.toContain('pid123');
        for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain('sec_abc');
        await expectNoAdoption();
    });
    it('treats malformed pairing input as persistent invalid input rather than a recognized V1 invite', async () => {
        const screen = await mount();
        await act(async () => { await cameraScan(screen, 'happier:///pair?v=1&secret=orphan_secret'); });
        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLinkDescription');
        expect(screen.findByTestId('restore-enrollment-retry')).not.toBeNull();
        expect(observed('/v1/auth/pairing/request')).toHaveLength(0); expect(boundary.alert).not.toHaveBeenCalled();
        await expectNoAdoption();
    });
});
