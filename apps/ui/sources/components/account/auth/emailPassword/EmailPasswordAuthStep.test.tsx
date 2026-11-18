import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { NativeEmailPasswordLoginResponseV1Schema, NativeEmailPasswordPreloginResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { installTokenStorageTestIsolation } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage, ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS } from '@/auth/storage/tokenStorage';
import { createAccountEncryptionFirstKeyFixture } from '@/dev/testkit/fixtures/accountEncryptionFirstKey';
import { createAccountEncryptionMigrateRequestBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { openAccountSecurityForHome, ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT } from '@/components/settings/account/openAccountSecurityForHome';
import { completeEmailPasswordAuthentication } from './completeEmailPasswordAuthentication';
import type { EmailPasswordLoginTarget } from '@/auth/password/loginEmailPassword';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
installTokenStorageTestIsolation('email-password-step', { preserveGenerations: true });
const boundary = vi.hoisted(() => ({ close: vi.fn(), authenticated: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { replace: boundary.replace } }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: {
    show: config => {
        // The person keeps the pending first-key migration at the native modal boundary.
        queueMicrotask(() => config.onRequestClose?.());
        return 'first-key-recovery';
    },
} }).module);
const browser = await installBrowserRuntimeForTests({ url: 'https://device.example.test' });
afterAll(() => browser.restore());
await initializeAuthRouteRuntimeForTests();
const { AuthProvider, useAuth } = await import('@/auth/context/AuthContext');
const { EmailPasswordAuthStep } = await import('./EmailPasswordAuthStep');

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const token = createAccountTokenForTests('account-b');
let TARGET: EmailPasswordLoginTarget = {
    endpointUrl: 'https://home-b.example.test', canonicalServerUrl: 'https://home-b.example.test',
    addressAnchorUrl: 'https://home-b.example.test', serverId: 'home-b', serverIdentityId: 'srv_home_b',
};
let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let local: ReturnType<typeof installLocalStorageMock>;
let blockFocus = false;

function Host({ exactHome = true }: { exactHome?: boolean }) {
    const auth = useAuth();
    return <EmailPasswordAuthStep
        target={TARGET} recoveryTarget={TARGET.serverIdentityId} action={exactHome ? 'connect' : 'login'} mode="either"
        onAuthenticated={async outcome => {
            boundary.authenticated(outcome);
            return await completeEmailPasswordAuthentication({ outcome,
                target: { serverUrl: TARGET.canonicalServerUrl, serverId: TARGET.serverId },
                loginWithCredentials: auth.loginWithCredentials, onCompleted: () => {},
            });
        }}
        {...(exactHome ? { reachExactHome: async () => await openAccountSecurityForHome({
            serverId: TARGET.serverId!, router: { replace: boundary.replace }, refreshAuth: auth.refreshFromActiveServer,
            intent: ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT,
        }) } : {})}
        onClose={boundary.close}
    />;
}
async function mount(exactHome = true): Promise<void> {
    screen = await renderScreen(<AuthProvider initialCredentials={null}><Host exactHome={exactHome} /></AuthProvider>);
}
async function submitLogin(): Promise<void> {
    if (screen!.findByTestId('email-password-connect-sign-in')) await screen!.pressByTestIdAsync('email-password-connect-sign-in');
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        screen!.findByTestId('email-password-password')!.props.onChangeText('a sufficiently long password');
    });
    await screen!.pressByTestIdAsync('email-password-submit');
}
beforeEach(async () => {
    browser.activate();
    local = installLocalStorageMock();
    blockFocus = false;
    local.setItemMock.mockImplementation((name, value) => {
        const previous = local.store.get(name);
        if (blockFocus && name.includes('server-profiles') && previous
            && JSON.parse(value).activeServerId !== JSON.parse(previous).activeServerId) throw new Error('Device storage unavailable');
        local.store.set(name, value);
    });
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Home B', serverUrl: TARGET.endpointUrl, serverIdentityId: TARGET.serverIdentityId, accountId: 'account-b', credentials: { token } });
    // The Account exists on its Home while this device is signed out.
    await TokenStorage.removeCredentialsForServerUrl(TARGET.endpointUrl, { serverId });
    TARGET = { ...TARGET, serverId };
    await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example.test', serverIdentityId: 'srv_focused_home', accountId: null });
    homes.answer(serverId, '/v1/auth/email/prelogin', { body: NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' }) });
    homes.answer(serverId, '/v1/auth/email/login', { body: NativeEmailPasswordLoginResponseV1Schema.parse({ token }) });
    boundary.close.mockClear(); boundary.authenticated.mockClear(); boundary.replace.mockClear();
});
afterEach(async () => {
    blockFocus = false;
    await screen?.unmount(); screen = null;
    const pending = await TokenStorage.readPendingExternalAuthStateForServerUrl(TARGET.canonicalServerUrl, { serverId: TARGET.serverId });
    if (pending.value) await TokenStorage.clearPendingExternalAuth({ serverUrl: TARGET.canonicalServerUrl, serverId: TARGET.serverId, removeFirstKeyMigrationAttempted: pending.value });
    await homes.reset(); local.restore();
    await standardCleanup();
});
it('closes only once the exact Home its Connect login committed on has been reached', async () => {
    await mount(); await submitLogin();
    await waitForHomeGovernance(() => expect(boundary.close, screen!.getTextContent()).toHaveBeenCalledOnce());
    expect(boundary.authenticated).toHaveBeenCalledOnce();
    expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeIdForIdentifier(TARGET.serverId));
    expect(boundary.replace).toHaveBeenCalledWith({ pathname: '/settings/account/security', params: { serverId: TARGET.serverId, intent: ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT } });
    expect(boundary.close).toHaveBeenCalledOnce();
});
it('keeps the authentication host open when credential recovery retires without adopting credentials', async () => {
    const fixture = await createAccountEncryptionFirstKeyFixture({ accountId: 'pending-account' });
    const now = Date.now();
    expect(await TokenStorage.setPendingExternalAuth({
        provider: 'github', proof: 'proof', secret: fixture.proposedCredentials.secret, serverId: TARGET.serverId, serverUrl: TARGET.canonicalServerUrl,
        accountEncryptionFirstKey: { accountId: fixture.accountId,
            requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({ request: fixture.request, accountId: fixture.accountId, sourceMode: 'plain' }),
            requestJson: JSON.stringify(fixture.request), pending: 'pending', createdAt: now, expiresAt: now + ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS, migrationSubmissionAttempted: true },
    }, { serverUrl: TARGET.canonicalServerUrl, serverId: TARGET.serverId })).toBe(true);
    await mount(); await submitLogin();
    expect(boundary.authenticated).toHaveBeenCalledOnce();
    expect(boundary.close).not.toHaveBeenCalled(); expect(boundary.replace).not.toHaveBeenCalled();
    expect(await TokenStorage.getCredentialsForServerUrl(TARGET.canonicalServerUrl, { serverId: TARGET.serverId })).toBeNull();
});
it('keeps a completed Connect login retryable instead of closing over a blocked activation', async () => {
    await mount(); blockFocus = true; await submitLogin();
    expect(boundary.close).not.toHaveBeenCalled(); expect(boundary.replace).not.toHaveBeenCalled();
    await waitForHomeGovernance(() => expect(screen!.findByTestId('email-password-modal-destination-home-error'), screen!.getTextContent()).not.toBeNull());
    expect(screen!.findByTestId('email-password-email')).toBeNull();
    expect(await TokenStorage.getCredentialsForServerUrl(TARGET.canonicalServerUrl, { serverId: TARGET.serverId })).toEqual({ token });
    blockFocus = false; await screen!.pressByTestIdAsync('email-password-modal-destination-home-retry');
    await waitForHomeGovernance(() => expect(boundary.close).toHaveBeenCalledOnce());
    expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeIdForIdentifier(TARGET.serverId));
    expect(homes.requestsFor('/v1/auth/email/login')).toHaveLength(1); expect(boundary.authenticated).toHaveBeenCalledOnce();
});
it('closes on a completed login when the host owns no exact-Home arrival', async () => {
    await mount(false); await submitLogin();
    await waitForHomeGovernance(() => expect(boundary.close, screen!.getTextContent()).toHaveBeenCalledOnce());
    expect(boundary.replace).not.toHaveBeenCalled(); expect(boundary.close).toHaveBeenCalledOnce();
    expect(await TokenStorage.getCredentialsForServerUrl(TARGET.canonicalServerUrl, { serverId: TARGET.serverId })).toEqual({ token });
});
