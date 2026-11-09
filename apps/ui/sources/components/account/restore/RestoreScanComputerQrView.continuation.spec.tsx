import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { deriveHomeQrBindingKeyV2} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { sealTerminalProvisioningV3TokenOnlyPayload} from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { encodeTerminalConnectLinkV4Payload } from '@happier-dev/protocol/auth/terminalConnectLinkV4';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { adoptHomeProfile, getActiveServerId, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { resumeAccountServicePostAuth, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { RestoreScanComputerQrView } from './RestoreScanComputerQrView';
import { t } from '@/text';

installTokenStorageWebPlatformMocks();
// The network boundary: every request the real HTTP client issues, keyed by observed origin and path.
const boundary = { request: vi.fn() };

/** Non-secret binding to the Account credential a continuation was created under. */
const ACCOUNT_CREDENTIAL_TOKEN_DIGEST = 'C0jknAf55a-WIBFlxj8xId4cq00hoNQDzcbt4__9tlM';
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await screen?.unmount(); resetRuntimeFetch(); restore?.(); });

it.each(['valid', 'expired'] as const)('dispatches a %s pasted terminal link without enrollment or automatic approval', async state => {
    restore = installLocalStorageMock().restore;
    navigation.push.mockClear();
    const fixture = createDirectoryHttpFixture();
    const descriptor = fixture.home.connectionDescriptor;
    const home = await adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(home.id, { scope: 'device' });
    const requests: string[] = [];
    setRuntimeFetch(async (input) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        return new Response(JSON.stringify({ ...createRootLayoutFeaturesResponse({
            features: { auth: { pairing: { boundQrV2: { enabled: true }, desktopQrMobileScan: { enabled: true } } } },
            capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
        }), homeConnectionDescriptor: descriptor }), { headers: { 'Content-Type': 'application/json' } });
    });
    const payload = encodeTerminalConnectLinkV4Payload({
        v: 4, publicKeyB64Url: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'),
        pairing: { v: 3, secretB64Url: encodeBase64(new Uint8Array(32).fill(17), 'base64url'),
            createdAtMs: Date.now() - 60_000, expiresAtMs: state === 'expired' ? Date.now() - 1 : Date.now() + 60_000,
            homeServerIdentityId: descriptor.homeServerIdentityId, supportsTokenOnly: true },
        homeConnectionDescriptor: descriptor,
    });
    const openPairingLinkEntry = vi.fn();
    screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <RestoreScanComputerQrView embedded entryIntent="add_home" initialPairingLink={`happier://terminal?v4=${payload}`}
            onOpenPairingLinkEntry={openPairingLinkEntry} />
    </InjectedAuthProvider>);
    const pending = await import('@/sync/domains/pending/pendingTerminalConnect');
    if (state === 'expired') {
        // A pasted terminal link is a link, so its expiry is worded for links, not QR codes.
        await vi.waitFor(() => expect(screen!.getTextContent()).toContain(t('modals.authRequestExpiredDescription')));
        expect(screen!.getTextContent()).not.toContain(t('connect.pairingQrExpired'));
        expect(navigation.push).not.toHaveBeenCalled();
        expect(pending.getPendingTerminalConnect()).toBeNull();
        // The same link can never work again: the one way on is a new link, not a retry of this one.
        expect(screen!.findByTestId('restore-enrollment-retry')).toBeNull();
        await screen!.pressByTestIdAsync('restore-enrollment-paste-new');
        expect(openPairingLinkEntry).toHaveBeenCalledTimes(1);
    } else {
        await vi.waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/terminal/connect'));
        expect(pending.getPendingTerminalConnect()).toMatchObject({ homeConnectionDescriptor: descriptor, serverIdentityId: descriptor.homeServerIdentityId });
    }
    expect(requests.filter(path => path.includes('/auth/'))).toEqual([]);
    pending.clearPendingTerminalConnect();
});

it('resumes no-Homes recovery only after exact QR credentials commit, without enrollment or focus', async () => {
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    fixture.state.homes = [];
    const descriptorA = { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_home_a',
        canonicalServerUrl: 'https://home-a.test', endpoints: [{ kind: 'https' as const, url: 'https://home-a.test' }] };
    const homeA = await adoptHomeProfile({ descriptor: descriptorA, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(homeA.id, { scope: 'device' });
    const activeHomeA = getActiveServerId();
    const credentialsA = { token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };
    await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: 'srv_home_a' }, credentialsA);
    const secret = new Uint8Array(32).fill(37);
    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + 60_000;
    const invite = { v: 2 as const, intent: 'home_device' as const, direction: 'trusted_home_displays' as const,
        pairId: 'pair-home-b', home: fixture.home.connectionDescriptor,
        qrSecretBase64Url: encodeBase64(secret, 'base64url'), issuedAtMs, expiresAtMs };
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        return boundary.request(url.origin, url.pathname, init);
    });
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path === '/v1/features') {
            const descriptor = endpoint === homeA.serverUrl ? descriptorA : fixture.home.connectionDescriptor;
            return json({ ...createRootLayoutFeaturesResponse({
                features: { auth: { pairing: { boundQrV2: { enabled: true }, desktopQrMobileScan: { enabled: true } } } },
                capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
            }), homeConnectionDescriptor: descriptor });
        }
        if (path === '/v1/auth/pairing/request') return json({ state: 'requested' });
        if (path === '/v2/auth/account/request') {
            const body = JSON.parse(String(init?.body));
            if (!body.pairId) return json({});
            const publicKey = decodeBase64(body.publicKey);
            return json({ state: 'authorized',
                tokenEncrypted: encodeBase64(encryptBox(new TextEncoder().encode(fixture.token), publicKey)),
                response: encodeBase64(sealTerminalProvisioningV3TokenOnlyPayload({
                    terminalEphemeralPublicKey: publicKey, pairingSecret: deriveHomeQrBindingKeyV2(secret),
                    createdAtMs: issuedAtMs, expiresAtMs, randomBytes: tweetnacl.randomBytes,
                })),
            });
        }
        return fixture.request(endpoint, path, init);
    });
    const input = { service: fixture.service,
        credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
        session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
        intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
    let result: AccountPostAuthResult | undefined;
    screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <RestoreScanComputerQrView embedded entryIntent="add_home"
            initialPairingLink={buildHomeQrInviteDeepLink({ invite })}
            onAuthenticated={async (authenticatedHome) => {
                expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl,
                    { serverId: fixture.home.homeServerIdentityId })).toEqual(authenticatedHome.credentials);
                result = await resumeAccountServicePostAuth(input, { kind: 'account_connected_no_homes' }, authenticatedHome);
            }} />
    </InjectedAuthProvider>);
    await vi.waitFor(async () => expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl,
        { serverId: fixture.home.homeServerIdentityId })).toEqual({ token: fixture.token }));
    expect(result).toEqual({ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId });
    expect(getActiveServerId()).toBe(activeHomeA);
    expect(await TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, { serverId: 'srv_home_a' })).toEqual(credentialsA);
    expect(fixture.state.calls.some(({ path }) => path.startsWith('/v1/account-directory/') || path === '/v1/auth/home-login')).toBe(false);
});
