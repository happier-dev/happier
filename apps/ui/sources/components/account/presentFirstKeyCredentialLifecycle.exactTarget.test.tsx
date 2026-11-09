import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountEncryptionMigrateRequestSchema,
    createAccountEncryptionMigrateRequestBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { computeAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AuthProvider } from '@/auth/context/AuthContext';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { adoptHomeProfile, getActiveServerId, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { presentFirstKeyCredentialLifecycle } from './presentFirstKeyCredentialLifecycle';
import { router } from 'expo-router';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn(), show: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: boundary.show } }).module);

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await screen?.unmount(); restore?.(); resetRuntimeFetch(); });

it.each(['rejected', 'committed'])('finishes %s Home B first-key custody through its actual transport without focusing B or visiting Settings', async (custody) => {
    boundary.request.mockReset();
    boundary.show.mockReset();
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const homeA = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_home_a',
        canonicalServerUrl: 'https://home-a.test', endpoints: [{ kind: 'https', url: 'https://home-a.test' }] },
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    const runtimeOrigin = 'https://home-b-runtime.test';
    const homeB = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor,
        endpoints: [{ kind: 'https', url: runtimeOrigin }] }, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(homeA.id, { scope: 'device' });
    const activeHomeA = getActiveServerId();
    const target = { serverId: homeB.id, serverUrl: homeB.serverUrl };
    const seed = new Uint8Array(32).fill(7);
    const secret = encodeBase64(seed, 'base64url');
    const binding = await buildContentKeyBinding(seed);
    const request = AccountEncryptionMigrateRequestSchema.parse({ toMode: 'e2ee', expectedAccountVersion: 8,
        expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null, expectedSettingsVersion: 3,
        settingsContent: { t: 'encrypted', c: 'ciphertext' }, connectedServices: { action: 'assert_empty' },
        automations: { action: 'assert_empty' }, machines: { action: 'assert_empty' }, todos: { action: 'assert_empty' },
        artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' }, reviewComments: { action: 'assert_empty' },
        sessionOrganization: { action: 'assert_empty' }, pets: { action: 'assert_empty' },
        keyProof: { v: 1, publicKey: encodeBase64(deriveAccountSigningPublicKey(seed)), ...binding, signature: 'request-signature' },
    });
    expect(await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'proof-b', secret, ...target,
        returnTo: '/settings/account', accountEncryptionFirstKey: { accountId: 'account-home',
            requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({ request, accountId: 'account-home', sourceMode: 'plain' }),
            requestJson: JSON.stringify(request), createdAt: Date.now() - 60_000, expiresAt: Date.now() - 1,
            pending: 'pending-b', migrationSubmissionAttempted: true,
            ...(custody === 'rejected' ? { rejectedCredentialTokenDigest: 'A'.repeat(43) } : {}) },
    }, target)).toBe(true);
    if (custody === 'committed') await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, { token: fixture.token, secret });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    // The network port: the real HTTP client dials the origin it resolved for Home B.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        return await boundary.request(url.origin, url.pathname, init);
    });
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (endpoint !== runtimeOrigin) throw new Error(`Wrong first-key transport: ${endpoint}`);
        if (path === '/v1/features') return json(createRootLayoutFeaturesResponse({ capabilities: {
            auth: { keyChallenge: { v2: true } }, serverIdentity: { serverIdentityId: 'srv_home_b' }, server: { canonicalServerUrl: homeB.serverUrl },
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
        } }));
        if (path === '/v1/auth/challenge') {
            expect(JSON.parse(String(init?.body)).expectedAccountId).toBe('account-home');
            return json({ challengeId: 'challenge-b', nonce: 'nonce', issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                audience: { origin: homeB.serverUrl, serverIdentityId: 'srv_home_b' } });
        }
        if (path === '/v1/auth') return json({ token: fixture.token });
        if (path === '/v1/account/encryption/currentness') return json({ mode: 'e2ee', version: 9, updatedAt: 1,
            signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(seed)),
            contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(decodeBase64(binding.contentPublicKey)),
        });
        throw new Error(`Unexpected first-key request: ${path}`);
    });
    screen = await renderScreen(<AuthProvider initialCredentials={null}><></></AuthProvider>);
    let completed = false;
    const presented = presentFirstKeyCredentialLifecycle({ run: async () => {
        const guard = await guardAccountEncryptionFirstKeyCredentialMutation(target);
        return guard.kind === 'allowed' ? { kind: 'completed' } : guard;
    }, onCompleted: () => { completed = true; } });
    await vi.waitFor(() => expect(boundary.show).toHaveBeenCalled());
    const modal = boundary.show.mock.calls.at(-1)![0];
    boundary.show.mockImplementation((nested) => { nested.onHostUnmount?.(); });
    const focusChanges: string[] = [];
    const unsubscribe = subscribeActiveServer((snapshot) => { if (snapshot.serverId !== activeHomeA) focusChanges.push(snapshot.serverId); });
    try {
        const finished = await modal.props.finish();
        expect(focusChanges).toEqual([]);
        expect(finished, JSON.stringify(boundary.request.mock.calls.map(([endpoint, path]) => ({ endpoint, path })))).toEqual({ kind: 'completed' });
        modal.props.onSettled('finish');
        await presented;
        expect(completed).toBe(true);
        expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toEqual({ token: fixture.token, secret });
        expect(router.push).not.toHaveBeenCalled();
    } finally { unsubscribe(); modal.onHostUnmount(); await presented; }
});
