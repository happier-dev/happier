import * as React from 'react';
import { isDeepStrictEqual } from 'node:util';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHomeQrBindingProofV2} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';
import { type HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installAccountCommonModuleMocks } from '../../account/accountTestHelpers';

const modalMocks = vi.hoisted(() => ({ alertAsync: vi.fn(async () => {}) }));
const clipboardMocks = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_value: string) => {}) }));
vi.mock('expo-clipboard', () => clipboardMocks);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@shopify/react-native-skia', async () =>
    (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());

installTokenStorageWebPlatformMocks();
installAccountCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: modalMocks, renderCustomModals: true }).module;
    },
});

await initializeRealAppRuntimeForTests();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');
const { storage } = await import('@/sync/domains/state/storageStore');
const profiles = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
const { encodeBase64, decodeBase64 } = await import('@/encryption/base64');
const atmosphere = storage.getState().settings.homeAtmosphere;
const accountSettings = { homeAtmosphere: { ...atmosphere,
    moments: { ...atmosphere.moments, qr: false, pairing: false },
} };

type HttpReply = Readonly<{ status: number; body: unknown }>;
type PairingRequest = Readonly<{
    serverId: string; path: string; input: Record<string, unknown>; authenticatedForTarget: boolean;
}>;
type SavedHome = Readonly<{
    profileId: string; serverIdentityId: string; serverUrl: string; descriptor: HomeConnectionDescriptorV1 | null;
}>;
const pairingRequests: PairingRequest[] = [];
const featureReplies = new Map<string, ReturnType<typeof createRootLayoutFeaturesResponse>>();
let fixtureSequence = 0;
let focusedHome: SavedHome;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let localStorage: ReturnType<typeof installLocalStorageMock> | null = null;
let pairingExpiresAt = '';
let pairingStatusResponse: HttpReply | null = null;
let accountApprovalResponse: HttpReply;
let beforeStart: (() => void) | null = null;
let statusReply: (() => HttpReply) | null = null;
let currentnessReads = 0;
let currentnessGate: Promise<void> | null = null;
let releaseCurrentness: (() => void) | null = null;
const pairId = 'pair-add-phone';

function json(reply: HttpReply): Response {
    return Response.json(reply.body, { status: reply.status });
}

function pendingStatus(): HttpReply {
    return { status: 200, body: { state: 'pending', pairId, expiresAt: pairingExpiresAt } };
}

// The genuine HTTP port serves focused and retained Homes. All credential, feature,
// descriptor, currentness, lifecycle and encryption decisions stay with their real owners.
const request: NonNullable<Parameters<typeof setRuntimeFetch>[0]> = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const home = homes.findByServerUrl(url.origin);
    if (!home) throw new Error('Unexpected Add Phone fixture Home');
    const path = url.pathname;
    if (path === '/v1/features' || path === '/v1/features/authenticated') {
        const features = featureReplies.get(url.origin);
        if (!features) throw new Error('Add Phone fixture features were not installed');
        return Response.json(features);
    }
    if (path === '/v1/account/encryption/currentness') {
        currentnessReads += 1;
        const gate = currentnessGate;
        currentnessGate = null;
        await gate;
        return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
    }
    if (path.startsWith('/v1/auth/pairing/') || path === '/v1/auth/account/response') {
        const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Malformed pairing fixture request');
        const authorization = new Headers(init?.headers).get('Authorization');
        pairingRequests.push({ serverId: home.serverId, path, input: body as Record<string, unknown>,
            authenticatedForTarget: home.token !== null && authorization === `Bearer ${home.token}` });
        if (path === '/v1/auth/pairing/start') {
            beforeStart?.();
            return json({ status: 200, body: { pairId, expiresAt: pairingExpiresAt } });
        }
        if (path === '/v1/auth/pairing/status') return json(statusReply?.() ?? pairingStatusResponse ?? pendingStatus());
        if (path === '/v1/auth/account/response') return json(accountApprovalResponse);
        if (path === '/v1/auth/pairing/consume') return json({ status: 200, body: { success: true } });
        throw new Error('Unexpected Add Phone fixture pairing operation');
    }
    return createEmptyAccountBootstrapHttpResponse(`${path}${url.search}`, init) ?? homes.request(input, init);
};

async function saveHome(options: Readonly<{
    name?: string; local?: boolean; boundQrV2?: boolean; descriptor?: HomeConnectionDescriptorV1;
}> = {}): Promise<SavedHome> {
    const sequence = ++fixtureSequence;
    const serverUrl = options.descriptor?.canonicalServerUrl
        ?? (options.local ? `http://localhost:${19000 + sequence}` : `https://add-phone-${sequence}.example.test`);
    const homeServerIdentityId = options.descriptor?.homeServerIdentityId ?? `srv_add_phone_${sequence}`;
    const descriptor = options.local ? null : options.descriptor ?? {
        v: 1 as const, homeServerIdentityId, canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https' as const, url: serverUrl }],
    };
    const savedId = await homes.addHome({ name: options.name ?? 'Focused Home', serverUrl,
        serverIdentityId: homeServerIdentityId, accountId: 'phone-account', currentAccount: true, active: false });
    // Pairing observes the static QR; its real Account settings read must retain that preference.
    homes.answer(savedId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: accountSettings } } });
    const profile = descriptor ? await profiles.adoptHomeProfile({ descriptor, source: 'qr',
        descriptorAuthority: 'current_connection_observation' }) : profiles.getServerProfileById(savedId);
    if (!profile) throw new Error('Add Phone fixture Home was not saved');
    const features = { ...createRootLayoutFeaturesResponse(), ...(descriptor ? { homeConnectionDescriptor: descriptor } : {}) };
    features.capabilities.serverIdentity.serverIdentityId = homeServerIdentityId;
    features.capabilities.server.canonicalServerUrl = serverUrl;
    if (!tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', options.boundQrV2 !== false)) {
        throw new Error('Add Phone fixture feature declaration was unavailable');
    }
    featureReplies.set(new URL(serverUrl).origin, features);
    return { profileId: profile.id, serverIdentityId: homeServerIdentityId, serverUrl, descriptor };
}

async function focusHome(options: Parameters<typeof saveHome>[0] = {}) {
    await connection?.dispose();
    connection = null;
    focusedHome = await saveHome(options);
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(focusedHome.serverUrl, { serverId: focusedHome.serverIdentityId });
    if (!credentials) throw new Error('Add Phone fixture Home credentials were unavailable');
    connection = await restoreServerAccountForTest({ serverUrl: focusedHome.serverUrl,
        serverIdentityId: focusedHome.serverIdentityId, accountId: 'phone-account', credentials, request,
        additionalRequestOrigins: [...featureReplies.keys()],
    });
}

async function renderAuthenticated(element: React.ReactNode) {
    if (!connection) throw new Error('Add Phone fixture Account was not restored');
    // The same external port also serves Homes saved after the focused Account was restored.
    setRuntimeFetch(request);
    return renderScreen(<AuthProvider initialCredentials={connection.credentials}>{element}</AuthProvider>);
}

async function renderPhone() {
    const screen = await renderAuthenticated(<AddPhoneSettingsView />);
    // The code slot is `add-phone-qr` from the first moment of making a code (it holds the spinner);
    // it is the answer only once the ready code labels itself.
    await waitForHomeGovernance(() => expect(
        screen.findByTestId('add-phone-qr')?.props.accessibilityLabel !== undefined
        || ['add-phone-expired', 'add-phone-update-required', 'add-phone-invalid-request', 'add-phone-complete']
            .some(testId => screen.findByTestId(testId) !== null),
    ).toBe(true));
    return screen;
}

function requestsFor(path: string) {
    return pairingRequests.filter(candidate => candidate.path === path);
}

function readInvite(screen: Awaited<ReturnType<typeof renderPhone>>) {
    // The renderer exposes the memo's inner component; read the real QR renderer's encoded payload.
    const qr = screen.findByTestId('add-phone-qr')?.findAll(node => typeof node.props.data === 'string')[0];
    const parsed = qr ? parseHomeQrInviteDeepLink(String(qr.props.data)) : null;
    if (!parsed) throw new Error('Expected a valid Add Phone QR invite');
    return parsed.invite;
}

async function requestPhone(screen: Awaited<ReturnType<typeof renderPhone>>) {
    const invite = readInvite(screen);
    const { generateAuthKeyPair } = await import('@/auth/flows/qrStart');
    const requester = generateAuthKeyPair();
    pairingStatusResponse = { status: 200, body: {
        state: 'requested', pairId: invite.pairId, expiresAt: new Date(invite.expiresAtMs).toISOString(),
        requestedPublicKey: encodeBase64(requester.publicKey), requestedDeviceLabel: 'Phone',
        homeServerIdentityId: invite.home.homeServerIdentityId,
        bindingProof: computeHomeQrBindingProofV2({ direction: invite.direction,
            qrSecret: decodeBase64(invite.qrSecretBase64Url, 'base64url'), pairId: invite.pairId,
            homeServerIdentityId: invite.home.homeServerIdentityId, requesterPublicKey: requester.publicKey,
            expiresAtMs: invite.expiresAtMs,
        }),
    } };
    return { invite, requester };
}

function expectCancellation() {
    const cancellation = requestsFor('/v1/auth/pairing/consume').at(-1);
    expect({ matchingPair: cancellation?.input.pairId === pairId, cancellationIntent: cancellation?.input.intent === 'cancel',
        fields: Object.keys(cancellation?.input ?? {}).sort(), authenticated: cancellation?.authenticatedForTarget,
    }).toEqual({ matchingPair: true, cancellationIntent: true, fields: ['intent', 'pairId'], authenticated: true });
}

describe('AddPhoneSettingsView', () => {
    beforeEach(async () => {
        localStorage = installLocalStorageMock();
        pairingRequests.length = 0;
        featureReplies.clear();
        pairingExpiresAt = new Date(Date.now() + 60_000).toISOString();
        pairingStatusResponse = null;
        accountApprovalResponse = { status: 200, body: { success: true } };
        beforeStart = null;
        statusReply = null;
        currentnessReads = 0;
        currentnessGate = null;
        releaseCurrentness = null;
        await focusHome();
    });
    afterEach(async () => {
        releaseCurrentness?.();
        currentnessGate = null;
        await standardCleanup();
        await connection?.dispose();
        connection = null;
        await homes.reset();
        localStorage?.restore();
        localStorage = null;
        clipboardMocks.setStringAsync.mockClear();
        modalMocks.alertAsync.mockClear();
    });

    it('issues and cancels the modal code on its displayed Home while another Home stays focused', async () => {
        const background = await saveHome({ name: 'Home B' });
        const { Modal, ModalProvider } = await import('@/modal');
        const { showHomePairingModal } = await import('@/components/auth/pairing/HomePairingModal');
        Modal.hideAll();
        const screen = await renderAuthenticated(<ModalProvider>{null}</ModalProvider>);
        await act(async () => showHomePairingModal('phone', background.profileId));
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-pairing-modal-qr')?.props.accessibilityLabel !== undefined).toBe(true));
        const start = requestsFor('/v1/auth/pairing/start').at(-1);
        expect({ serverId: start?.serverId, authenticated: start?.authenticatedForTarget })
            .toEqual({ serverId: background.profileId, authenticated: true });
        expect(getActiveServerSnapshot().serverId).toBe(focusedHome.serverIdentityId);
        await act(async () => Modal.hideAll());
        await waitForHomeGovernance(() => expect(requestsFor('/v1/auth/pairing/consume').length).toBe(1));
        expectCancellation();
        expect(requestsFor('/v1/auth/pairing/consume')[0]?.serverId).toBe(background.profileId);
        expect(screen.findByTestId('home-pairing-modal-qr') === null).toBe(true);
    });

    it('renders a pairing QR code after starting a session', async () => {
        const screen = await renderPhone();
        const invite = readInvite(screen);
        expect({ v: invite.v, intent: invite.intent, matchingPair: invite.pairId === pairId, homeId: invite.home.homeServerIdentityId })
            .toEqual({ v: 2, intent: 'home_device', matchingPair: true, homeId: focusedHome.serverIdentityId });
        expect(screen.findByTestId('add-phone-countdown') !== null).toBe(true);
        expect(screen.getTextContent().includes('homeSetup.waitingForPhone')).toBe(true);
    });

    it('pairs against the selected saved Home without changing the focused Home', async () => {
        const background = await saveHome({ name: 'Home B' });
        const screen = await renderPhone();
        pairingRequests.length = 0;
        await screen.pressByTestIdAsync(`add-phone-home-profile-${background.profileId}`);
        await waitForHomeGovernance(() => expect(requestsFor('/v1/auth/pairing/start').length).toBe(1));
        const start = requestsFor('/v1/auth/pairing/start')[0];
        expect({ serverId: start?.serverId, authenticated: start?.authenticatedForTarget })
            .toEqual({ serverId: background.profileId, authenticated: true });
        expect(getActiveServerSnapshot().serverId).toBe(focusedHome.serverIdentityId);
        expect(screen.getTextContent().includes('connect.addPhoneChooseHomeFooter')).toBe(true);
    });

    it('clears the QR code when the Home gives up on a code early, and offers a new one', async () => {
        pairingStatusResponse = { status: 404, body: { error: 'not_found' } };
        const screen = await renderPhone();
        await waitForHomeGovernance(() => expect(screen.findByTestId('add-phone-expired') !== null).toBe(true));
        expect(screen.findAllByTestId('add-phone-qr').length).toBe(0);
        expect(screen.getTextContent().includes('connect.pairingQrExpired')).toBe(true);
        expect(screen.findByTestId('add-phone-generate')?.props.disabled).toBe(false);
        expect(requestsFor('/v1/auth/pairing/start').length).toBe(1);
    });

    it('makes the next code when the current one runs out while the page stays open', async () => {
        let starts = 0;
        let currentExpiresAtMs = 0;
        beforeStart = () => {
            currentExpiresAtMs = Date.now() + (++starts === 1 ? 1_200 : 60_000);
            pairingExpiresAt = new Date(currentExpiresAtMs).toISOString();
        };
        statusReply = () => Date.now() >= currentExpiresAtMs
            ? { status: 404, body: { error: 'not_found' } } : pendingStatus();
        const screen = await renderPhone();
        await waitForHomeGovernance(async () => {
            await flushHookEffects({ cycles: 1 });
            expect(requestsFor('/v1/auth/pairing/start').length).toBe(2);
            expect(screen.getTextContent().includes('homeSetup.waitingForPhone')).toBe(true);
        });
    });

    it('renders the lifecycle update requirement inline when the selected Home lacks bound QR v2', async () => {
        await focusHome({ boundQrV2: false });
        const screen = await renderPhone();
        expect(screen.findByTestId('add-phone-update-required') !== null).toBe(true);
        expect(screen.getTextContent().includes('connect.updateRequiredTitle')).toBe(true);
        expect(screen.getTextContent().includes('connect.updateRequiredBody')).toBe(true);
        expect(screen.getTextContent().includes('modals.pleaseSignInFirst')).toBe(false);
        expect(modalMocks.alertAsync.mock.calls.length).toBe(0);
    });

    it('fails closed when a local development Home has no shareable application endpoint', async () => {
        await focusHome({ local: true });
        const screen = await renderPhone();
        expect(screen.getTextContent().includes('connect.serverUrlNotEmbeddedTitle')).toBe(false);
        expect(screen.findAllByTestId('add-phone-qr').length).toBe(0);
        expect(screen.getTextContent().includes('homeSetup.codeFailed')).toBe(true);
    });

    it('keeps the pairing link behind disclosure and copies it without exposing the secret in a success modal', async () => {
        const screen = await renderPhone();
        expect(screen.findAllByTestId('add-phone-pairing-link').length).toBe(0);
        expect(screen.findByTestId('add-phone-pairing-link-details')?.props.accessibilityState).toMatchObject({ expanded: false });
        await screen.pressByTestIdAsync('add-phone-pairing-link-details');
        expect(screen.findByTestId('add-phone-pairing-link') !== null).toBe(true);
        expect(screen.findByTestId('add-phone-pairing-link-details')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.getTextContent().includes('connect.pairingLinkSecurityWarning')).toBe(true);
        await screen.pressByTestIdAsync('add-phone-pairing-link-copy');
        expect(clipboardMocks.setStringAsync.mock.calls.length).toBe(1);
        expect(parseHomeQrInviteDeepLink(String(clipboardMocks.setStringAsync.mock.calls[0]?.[0]))?.invite.v === 2).toBe(true);
        expect(modalMocks.alertAsync).not.toHaveBeenCalledWith('common.success', 'common.copied');
        expect(screen.findByTestId('add-phone-pairing-link-copy-feedback') !== null).toBe(true);
    });

    it('automatically completes the captured Home once with no code or direct-QR decision UI', async () => {
        accountApprovalResponse = { status: 409, body: { error: 'already_completed' } };
        const screen = await renderPhone();
        const { invite, requester } = await requestPhone(screen);
        await waitForHomeGovernance(() => expect(screen.findByTestId('add-phone-complete') !== null).toBe(true));
        for (const testId of ['add-phone-request-confirm-code', 'add-phone-approve', 'add-phone-reject',
            'add-phone-pairing-link-details', 'add-phone-pairing-link']) {
            expect(screen.findByTestId(testId) === null).toBe(true);
        }
        expect(screen.getTextContent().includes('homeSetup.deviceJoined')).toBe(true);
        expect(screen.getTextContent().includes('connect.homeAddedPreservedFocusBody')).toBe(false);
        expect(screen.getTextContent().includes('common.unavailable')).toBe(false);
        const approval = requestsFor('/v1/auth/account/response')[0];
        const body = approval?.input;
        expect({ matchingHome: approval?.serverId === focusedHome.profileId, authenticated: approval?.authenticatedForTarget,
            matchingPair: body?.pairId === invite.pairId, matchingRequester: body?.publicKey === encodeBase64(requester.publicKey),
            matchingIdentity: body?.homeServerIdentityId === focusedHome.serverIdentityId,
            correctResponseKind: body?.responseKind === 'tokenOnly', hasSealedResponse: typeof body?.response === 'string',
            disclosedCredential: Boolean(connection && JSON.stringify(body ?? {}).includes(connection.credentials.token)),
        }).toEqual({ matchingHome: true, authenticated: true, matchingPair: true, matchingRequester: true,
            matchingIdentity: true, correctResponseKind: true, hasSealedResponse: true, disclosedCredential: false });
        const { inspectTerminalProvisioningV3Payload} = await import('@happier-dev/protocol/crypto/terminalProvisioningV2');
        expect(inspectTerminalProvisioningV3Payload(decodeBase64(String(body?.response)))?.type).toBe('tokenOnly');
        expect(requestsFor('/v1/auth/pairing/consume').length).toBe(0);
        expect(requestsFor('/v1/auth/account/response').length).toBe(1);
        expect(requestsFor('/v1/auth/pairing/start').length).toBe(1);
    });

    it('does not complete with a replacement Account after captured Home credentials retire', async () => {
        const screen = await renderPhone();
        const captured = captureActiveServerAccountScopeLifetime();
        expect(captured?.isCurrent()).toBe(true);
        expect(captured?.scope.accountId).toBe('phone-account');
        expect(profiles.areServerProfileIdentifiersEquivalent(captured?.scope.serverId ?? '', focusedHome.serverIdentityId)).toBe(true);
        currentnessGate = new Promise<void>(resolve => { releaseCurrentness = resolve; });
        const initialReads = currentnessReads;
        await requestPhone(screen);
        await waitForHomeGovernance(() => expect(currentnessReads > initialReads).toBe(true));
        await homes.switchAccount(focusedHome.profileId, 'replacement-phone-account', { currentAccount: true });
        expect(captured?.isCurrent()).toBe(false);
        const replacement = captureActiveServerAccountScopeLifetime();
        expect(replacement?.isCurrent()).toBe(true);
        expect(replacement?.scope.accountId).toBe('replacement-phone-account');
        releaseCurrentness?.();
        currentnessGate = null;
        await waitForHomeGovernance(() => expect(screen.findByTestId('add-phone-invalid-request') !== null).toBe(true));
        expect(requestsFor('/v1/auth/account/response').length).toBe(0);
        expect(screen.findByTestId('add-phone-complete') === null).toBe(true);
        expect(screen.findByTestId('add-phone-pairing-link') === null).toBe(true);
    });

    it('shows one create-new-QR recovery after a terminal completion failure', async () => {
        accountApprovalResponse = { status: 403, body: { error: 'forbidden' } };
        const screen = await renderPhone();
        await requestPhone(screen);
        await waitForHomeGovernance(() => expect(screen.findByTestId('add-phone-invalid-request') !== null).toBe(true));
        expect(screen.findAllHostsByTestId('add-phone-generate').length).toBe(1);
        expect(screen.findByTestId('add-phone-generate')?.props.disabled).toBe(false);
        expect(screen.findByTestId('add-phone-approve') === null).toBe(true);
        expect(screen.findByTestId('add-phone-reject') === null).toBe(true);
    });

    it('omits only the QR image and keeps the exact link behind disclosure when the invite exceeds QR capacity', async () => {
        const serverUrl = `https://large-add-phone-${fixtureSequence + 1}.example.test`;
        const descriptor: HomeConnectionDescriptorV1 = { v: 1, homeServerIdentityId: `srv_large_add_phone_${fixtureSequence + 1}`,
            canonicalServerUrl: serverUrl, revision: 1, endpoints: [
                { kind: 'iroh', endpointId: 'a'.repeat(64),
                    relayUrls: Array.from({ length: 4 }, (_, index) => `https://relay-${index}.example.test/${'a'.repeat(470)}`),
                    directAddresses: ['192.0.2.10:443', '192.0.2.11:443'] },
                { kind: 'https', url: serverUrl },
            ] };
        await focusHome({ descriptor });
        const screen = await renderPhone();
        expect(screen.findByTestId('add-phone-qr')?.findAll(node => typeof node.props.data === 'string').length).toBe(0);
        expect(screen.getTextContent().includes('connect.pairingQrTooLargeTitle')).toBe(true);
        expect(screen.getTextContent().includes('connect.pairingQrTooLargeBody')).toBe(true);
        expect(screen.findByTestId('add-phone-invalid-request') === null).toBe(true);
        expect(screen.findByTestId('add-phone-cancel') !== null).toBe(true);
        expect(screen.findAllByTestId('add-phone-pairing-link').length).toBe(0);
        await screen.pressByTestIdAsync('add-phone-pairing-link-details');
        expect(screen.getTextContent().includes('connect.pairingLinkSecurityWarning')).toBe(true);
        await screen.pressByTestIdAsync('add-phone-pairing-link-copy');
        expect(clipboardMocks.setStringAsync.mock.calls.length).toBe(1);
        const parsed = parseHomeQrInviteDeepLink(String(clipboardMocks.setStringAsync.mock.calls[0]?.[0]));
        expect(isDeepStrictEqual(parsed?.invite.home, descriptor)).toBe(true);
        await screen.pressByTestIdAsync('add-phone-cancel');
        expectCancellation();
    });

    it('cancels a pending invite through the strict cancellation decision and does not create a successor invite', async () => {
        const screen = await renderPhone();
        expect(screen.findByTestId('add-phone-generate') === null).toBe(true);
        expect(screen.findByTestId('add-phone-cancel') !== null).toBe(true);
        await screen.pressByTestIdAsync('add-phone-cancel');
        expectCancellation();
        expect(requestsFor('/v1/auth/pairing/start').length).toBe(1);
        expect(screen.findByTestId('add-phone-pairing-link') === null).toBe(true);
        expect(screen.findByTestId('add-phone-generate')?.props.disabled).toBe(false);
    });

    it('cancels the live code when the panel leaves the screen', async () => {
        const screen = await renderPhone();
        expect(screen.findByTestId('add-phone-qr') !== null).toBe(true);
        await act(async () => { screen.tree.unmount(); });
        await waitForHomeGovernance(() => expect(requestsFor('/v1/auth/pairing/consume').length).toBe(1));
        expectCancellation();
    });
});
