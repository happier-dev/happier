import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { IModal } from '@/modal';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { deriveHomeQrBindingKeyV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { installTokenStorageWebPlatformMocks, installTokenStorageTestIsolation } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installBrowserClipboardBoundary } from '@/dev/testkit/harness/browserClipboardBoundary';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createAccountTokenForTests, createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { t } from '@/text';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('restore_requester_navigation', { preserveGenerations: true });
const boundary = vi.hoisted(() => ({
    copy: vi.fn<(value: string) => Promise<boolean>>(async () => true),
    preventRemove: vi.fn(),
    replace: vi.fn(),
    alertAsync: vi.fn<IModal['alertAsync']>(async () => {}),
    holdTiming: false,
    heldTiming: [] as Array<(finished: boolean) => void>,
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ params: {}, router: { replace: boundary.replace } }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation'))
    .createReactNavigationNativeMock({ usePreventRemove: locked => boundary.preventRemove(locked) }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ spies: { alertAsync: (...args) => boundary.alertAsync(...args) } }).module);
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const module = createReanimatedModuleMock({ settleTimingCallbacks: true });
    return { ...module, withTiming: <T,>(value: T, config?: Parameters<typeof module.withTiming>[1], done?: (finished?: boolean) => void) => {
        if (done && boundary.holdTiming) {
            boundary.heldTiming.push(done);
            return module.withTiming(value, config);
        }
        return module.withTiming(value, config, done);
    } };
});

await initializeRealAppRuntimeForTests();
const profiles = await import('@/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
const { encryptBox } = await import('@/encryption/libsodium');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { RestoreQrView } = await import('./RestoreQrView');

const descriptor = HomeConnectionDescriptorV1Schema.parse({
    v: 1, homeServerIdentityId: 'srv_known_home', canonicalServerUrl: 'https://known-home.example.test',
    revision: 1, endpoints: [{ kind: 'https', url: 'https://known-home.example.test' }],
});
const homes = createHomeGovernanceHarness();
const enrolledToken = createAccountTokenForTests('known-home-account');
let storage: ReturnType<typeof installLocalStorageMock>;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let profileId = '';
let focusedProfileId = '';
let poll = createDeferred<Response>();
const heldResponses: Array<ReturnType<typeof createDeferred<Response>>> = [];
let link = '';
let registerCount = 0;
let registered = true;
let approvalPollSignal: AbortSignal | null;
let features = createRootLayoutFeaturesResponse();

async function seedHome(connection = descriptor) {
    profileId = await homes.addHome({ name: 'Known Home', serverUrl: connection.canonicalServerUrl,
        serverIdentityId: connection.homeServerIdentityId, accountId: 'known-home-account', active: false });
    profileId = (await profiles.adoptHomeProfile({ descriptor: connection, source: 'manual',
        descriptorAuthority: 'current_connection_observation' })).id;
    // The server Account exists; this device has not enrolled into it yet.
    await TokenStorage.removeCredentialsForServerUrl(connection.canonicalServerUrl, { serverId: profileId });
    features = createRootLayoutFeaturesResponse();
    features.capabilities.serverIdentity.serverIdentityId = connection.homeServerIdentityId;
    features.capabilities.server.canonicalServerUrl = connection.canonicalServerUrl;
    tryWriteServerEnabledBitInPlace(features, 'auth.pairing.desktopQrMobileScan', true);
    tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true);
}

async function mount(props: Partial<React.ComponentProps<typeof RestoreQrView>> = {}) {
    const screen = await renderScreen(<AuthProvider initialCredentials={null}>
        <RestoreQrView embedded entryIntent="enter_home" targetProfileId={profileId} {...props} />
    </AuthProvider>);
    await vi.waitFor(() => expect(screen.findByTestId('restore-requester-qr')).not.toBeNull());
    link = readRenderedQrLink(screen) ?? '';
    return screen;
}

function readRenderedQrLink(screen: Awaited<ReturnType<typeof renderScreen>>): string | undefined {
    // Read the rendered PairingQrCode's public link prop, independent of memo wrappers.
    return screen.findByTestId('restore-requester-qr')?.findAll(node => typeof node.props.link === 'string')[0]?.props.link;
}

function authorized(token = enrolledToken) {
    const parsed = parseHomeQrInviteDeepLink(link);
    if (!parsed || parsed.invite.direction !== 'requester_displays') throw new Error('Expected generated requester QR');
    const invite = parsed.invite;
    const publicKey = decodeBase64(invite.requesterPublicKeyBase64Url, 'base64url');
    return Response.json({ state: 'authorized',
        tokenEncrypted: encodeBase64(encryptBox(new TextEncoder().encode(token), publicKey)),
        response: encodeBase64(sealTerminalProvisioningV3TokenOnlyPayload({
            terminalEphemeralPublicKey: publicKey,
            pairingSecret: deriveHomeQrBindingKeyV2(decodeBase64(invite.qrSecretBase64Url, 'base64url')),
            createdAtMs: invite.issuedAtMs, expiresAtMs: invite.expiresAtMs, randomBytes: tweetnacl.randomBytes,
        })),
    });
}

beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev/restore' });
    storage = installLocalStorageMock();
    await homes.reset();
    resetServerFeaturesClientForTests();
    boundary.copy.mockClear(); boundary.preventRemove.mockClear(); boundary.replace.mockClear();
    boundary.holdTiming = false;
    boundary.heldTiming.length = 0;
    boundary.alertAsync.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
    installBrowserClipboardBoundary(async value => { await boundary.copy(value); });
    focusedProfileId = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-home.test' });
    await seedHome();
    poll = createDeferred<Response>(); heldResponses.push(poll);
    link = ''; registerCount = 0; registered = true; approvalPollSignal = null;
    setRuntimeFetch(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== descriptor.canonicalServerUrl) return homes.request(input, init);
        if (url.pathname === '/v1/features') return Response.json({ ...features });
        if (url.pathname === '/v1/auth/pairing/request') {
            registerCount += 1;
            return registered ? Response.json({ state: 'requested' }) : Response.json({ error: 'not_found' }, { status: 404 });
        }
        if (url.pathname === '/v2/auth/account/request') {
            const body: unknown = JSON.parse(String(init?.body ?? '{}'));
            if (body && typeof body === 'object' && 'pairId' in body) {
                approvalPollSignal = init?.signal ?? null;
                return waitForNetworkResponseForTests(poll.promise, init?.signal);
            }
            return Response.json({ state: 'requested' });
        }
        return homes.request(input, init);
    });
});
afterEach(async () => {
    await standardCleanup();
    for (const response of heldResponses.splice(0)) response.resolve(Response.json({}, { status: 410 }));
    await flushHookEffects();
    await disconnectActiveServerConnection();
    await homes.reset(); storage.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); browser.restore();
});

describe('RestoreQrView known-target requester QR', () => {
    it('renders the exact known-target requester QR with no code or approval controls', async () => {
        const screen = await mount();
        expect(parseHomeQrInviteDeepLink(link)?.invite.home).toEqual(descriptor);
        expect(screen.getTextContent()).toContain('known-home.example.test');
        expect(screen.findByTestId('restore-scan-confirm-code')).toBeNull();
        expect(screen.findByTestId('restore-approve')).toBeNull();
        expect(screen.findByTestId('restore-reject')).toBeNull();
    });
    it('keeps the secret-bearing link behind explicit warned disclosure, then copies the exact value', async () => {
        const screen = await mount();
        expect(screen.getTextContent()).not.toContain(t('connect.pairingLinkSecurityWarning'));
        expect(screen.findByTestId('restore-requester-link-value')).toBeNull();
        expect(screen.findByTestId('restore-copy-requester-link')).toBeNull();
        const details = screen.findByTestId('restore-requester-link-details');
        expect(details?.props.accessibilityState).toMatchObject({ expanded: false });
        await act(async () => details?.props.onPress());
        expect(screen.getTextContent()).toContain(t('connect.pairingLinkSecurityWarning'));
        expect(screen.findByTestId('restore-requester-link-value')?.props.children).toBe(link);
        await screen.pressByTestIdAsync('restore-requester-link-copy');
        expect(boundary.copy).toHaveBeenCalledWith(link);
    });
    it('keeps the exact live link row when only QR encoding is unavailable', async () => {
        await seedHome(HomeConnectionDescriptorV1Schema.parse({ ...descriptor, revision: 2,
            endpoints: [descriptor.endpoints[0], ...Array.from({ length: 15 }, (_, index) => ({
                kind: 'https', url: `https://endpoint-${index}.example.test/${'segment'.repeat(40)}`,
            }))],
        }));
        const screen = await mount();
        expect(readRenderedQrLink(screen)).toBeUndefined();
        expect(screen.getTextContent()).toContain(t('connect.pairingQrTooLargeBody'));
        await screen.pressByTestIdAsync('restore-requester-link-details');
        const disclosed = screen.findByTestId('restore-requester-link-value')?.props.children;
        expect(parseHomeQrInviteDeepLink(disclosed)?.invite.home.endpoints).toHaveLength(16);
    });
    it('removes the secret-bearing disclosure after terminal success', async () => {
        const screen = await mount({ entryIntent: 'add_home' });
        await act(async () => poll.resolve(authorized()));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('connect.homeAddedPreservedFocusBody')));
        expect(screen.findByTestId('restore-requester-link-details')).toBeNull();
        expect(screen.findByTestId('restore-requester-link')).toBeNull();
    });
    it('keeps Approved visible until its entrance settles before navigating Home', async () => {
        const screen = await mount();
        boundary.holdTiming = true;
        await act(async () => poll.resolve(authorized()));
        await vi.waitFor(() => expect(screen.findByTestId('restore-requester-approved')).not.toBeNull());
        expect(boundary.replace).not.toHaveBeenCalled();
        expect(boundary.heldTiming).toHaveLength(1);
        await act(async () => boundary.heldTiming.shift()?.(true));
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith('/'));
    });
    it('locks route removal only after trusted completion reaches credential adoption', async () => {
        const onNavigationLockChange = vi.fn();
        const screen = await mount({ onNavigationLockChange });
        expect(boundary.preventRemove).toHaveBeenLastCalledWith(false);
        const gate = createDeferred<void>();
        const requestLock = navigator.locks.request.bind(navigator.locks);
        vi.spyOn(navigator.locks, 'request').mockImplementation(async (...args: Parameters<typeof navigator.locks.request>) => {
            await gate.promise;
            return requestLock(...args);
        });
        try {
            await act(async () => poll.resolve(authorized()));
            await vi.waitFor(() => expect(boundary.preventRemove).toHaveBeenLastCalledWith(true));
            expect(onNavigationLockChange).toHaveBeenCalledWith(true);
            expect(screen.findByTestId('restore-requester-cancel')).toBeNull();
            expect(screen.findByTestId('restore-open-scan-qr')).toBeNull();
            expect(screen.findByTestId('restore-open-manual')).toBeNull();
        } finally { gate.resolve(); }
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith('/'));
    });
    it('does not register the waiting invite while the requester is hidden', async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        await mount();
        expect(registerCount).toBe(0);
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await vi.waitFor(() => expect(registerCount).toBe(1));
    });
    it('stops the authorization poll when leaving a registered but unapproved QR', async () => {
        const screen = await mount();
        await vi.waitFor(() => expect(approvalPollSignal).not.toBeNull());
        const inFlight = approvalPollSignal;
        await act(async () => screen.tree.unmount());
        expect(inFlight?.aborted).toBe(true);
    });
    it('opens the recovery key and pairing-link entry (with its camera) from the key on the ways row', async () => {
        registered = false;
        const onOpenPairingLinkEntry = vi.fn();
        const screen = await mount({ onOpenPairingLinkEntry });
        await screen.pressByTestIdAsync('restore-open-manual');
        expect(onOpenPairingLinkEntry).toHaveBeenCalledOnce();
    });
    it('starts a fresh requester invite when the presentation requires a new QR', async () => {
        const screen = await mount();
        const oldLink = link;
        await act(async () => poll.resolve(Response.json({}, { status: 410 })));
        await vi.waitFor(() => expect(screen.findByTestId('restore-requester-create-new-qr')).not.toBeNull());
        poll = createDeferred<Response>(); heldResponses.push(poll);
        await screen.pressByTestIdAsync('restore-requester-create-new-qr');
        await vi.waitFor(() => expect(readRenderedQrLink(screen)).toEqual(expect.any(String)));
        expect(readRenderedQrLink(screen)).not.toBe(oldLink);
        expect(registerCount).toBe(2);
        expect(screen.findByTestId('restore-requester-retry')).toBeNull();
    });
    it('replaces an invite after its deadline when the requester comes back into view', async () => {
        const screen = await mount();
        const oldLink = link;
        const invite = parseHomeQrInviteDeepLink(oldLink)?.invite;
        if (!invite) throw new Error('Expected a valid requester invite');
        await vi.waitFor(() => expect(approvalPollSignal).not.toBeNull());

        const realNow = Date.now;
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            vi.spyOn(Date, 'now').mockImplementation(() => Math.max(realNow(), invite.expiresAtMs + 1));
        });
        expect(registerCount).toBe(1);

        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await vi.waitFor(() => {
            const renewed = readRenderedQrLink(screen);
            expect(renewed).toEqual(expect.any(String));
            expect(renewed).not.toBe(oldLink);
            expect(parseHomeQrInviteDeepLink(renewed!)?.invite.pairId).not.toBe(invite.pairId);
        });
        expect(registerCount).toBe(2);
    });
    it('opens the exact adopted Home and enters the shell for enter_home', async () => {
        await mount();
        await act(async () => poll.resolve(authorized()));
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith('/'));
        expect(profiles.getActiveServerSnapshot().serverId).toBe(profiles.resolveServerProfileScopeIdForIdentifier(profileId));
        expect(await TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl,
            { serverId: profiles.resolveServerProfileScopeIdForIdentifier(profileId) }))
            .toEqual({ token: enrolledToken });
        expect(boundary.preventRemove).toHaveBeenLastCalledWith(false);
        expect(boundary.preventRemove.mock.invocationCallOrder.at(-1)!).toBeLessThan(boundary.replace.mock.invocationCallOrder[0]!);
    });
    it('retries the exact retained profile when opening enter_home is initially blocked', async () => {
        await mount();
        const setItem = browser.window.Storage.prototype.setItem;
        let refused = false;
        vi.spyOn(browser.window.Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
            if (!refused && key === 'activeServerId' && value === profileId) { refused = true; throw new Error('Storage temporarily unavailable'); }
            setItem.call(this, key, value);
        });
        boundary.alertAsync.mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find(button => button.style !== 'cancel')?.onPress?.();
        });
        await act(async () => poll.resolve(authorized()));
        await vi.waitFor(() => expect(boundary.replace).toHaveBeenCalledWith('/'));
        expect(refused).toBe(true);
        expect(boundary.alertAsync).toHaveBeenCalledOnce();
        expect(profiles.getActiveServerSnapshot().serverId).toBe(profiles.resolveServerProfileScopeIdForIdentifier(profileId));
    });
    it('returns to the shell without switching focus for add_home', async () => {
        const screen = await mount({ entryIntent: 'add_home' });
        await act(async () => poll.resolve(authorized()));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('connect.homeAddedPreservedFocusBody')));
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focusedProfileId);
        expect(boundary.replace).not.toHaveBeenCalled();
    });
});
