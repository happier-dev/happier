import * as React from 'react';
import ReactDOM from 'react-dom';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountSecurityGetResponseV1Schema, PasswordMutationPreparationRequestV1Schema, PasswordMutationPreparationResponseV1Schema, AccountPasswordChangeRequestV1Schema, AccountPasswordMutationResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { E2eeAccountPasswordCredentialV1Schema, encodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { KeyChallengeV2AuthRequestSchema } from '@happier-dev/protocol/auth/keyChallenge';
import { createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1, PasswordMutationChallengeV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installPasswordKdfWorkerBoundary } from '@/dev/testkit/mocks/passwordKdfWorker';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { keyChallengeV2Fixture } from '@/dev/testkit/fixtures/authChallengeFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { installTokenStorageTestIsolation } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
installTokenStorageTestIsolation('e2ee-password-recovery', { preserveGenerations: true });
const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const browser = await installBrowserRuntimeForTests({ url: 'https://device.example.test' });
afterAll(() => browser.restore());
await initializeAuthRouteRuntimeForTests();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { E2eePasswordRecoveryScreen } = await import('./E2eePasswordRecoveryScreen');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const HOME_A_URL = 'https://home-a.example.test';
const HOME_B_URL = 'https://home-b.example.test';
const SECURITY = '/v1/account/security';
const PREPARE = '/v1/auth/password/mutation/challenge';
const CHANGE = '/v1/account/password/change';
const PASSWORD = 'a genuinely long replacement password';
const secret = new Uint8Array(32).fill(9);
const key = encodeBase64(secret, 'base64url');
const token = createAccountTokenForTests('account-1');
let homeAProfileId = '';
let homeBProfileId = '';
let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let local: ReturnType<typeof installLocalStorageMock>;
let blockFocus = false;
let restorePortal: (() => void) | null = null;

function challenge(home: 'a' | 'b') {
    return keyChallengeV2Fixture({ challengeId: `challenge-${home}`,
        audience: { origin: home === 'a' ? HOME_A_URL : HOME_B_URL, serverIdentityId: `srv_home_${home}` },
    });
}
function answerSecurity(serverId: string, mode: 'plain' | 'e2ee' = 'e2ee') {
    homes.answer(serverId, SECURITY, { body: AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: mode, nativeEmail: 'person@example.test', password: { status: 'enrolled', revision: 7 } }) });
}
function answerPreparation(serverId: string, home: 'a' | 'b', respondAfter?: Promise<void>) {
    homes.answer(serverId, PREPARE, { select: input => {
        const request = PasswordMutationPreparationRequestV1Schema.parse(input);
        if (!('newE2eePassword' in request)) throw new Error('Expected E2EE password material');
        const targetCredential = E2eeAccountPasswordCredentialV1Schema.parse({ v: 1, kind: 'e2ee_password_envelope', envelope: request.newE2eePassword.envelope,
            authVerifier: { v: 1, hash: { v: 1, algorithm: 'scrypt', parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(6)), digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(7)) } },
        });
        const mutation = { v: 1 as const, action: request.action, accountId: 'account-1', expectedCredentialRevision: request.expectedCredentialRevision,
            normalizedNativeEmail: request.normalizedNativeEmail, newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential) };
        return { respondAfter, body: PasswordMutationPreparationResponseV1Schema.parse({ targetCredential, challenge: PasswordMutationChallengeV1Schema.parse({
            ...challenge(home), v: 1, expectedAccountId: 'account-1', operationKind: 'password_credential_mutation_v1', operationDigest: createPasswordCredentialMutationDigestV1(mutation),
        }) }) };
    } });
}
function root(home: 'a' | 'b') { return <AuthProvider initialCredentials={null}><E2eePasswordRecoveryScreen homeTarget={`srv_home_${home}`} /></AuthProvider>; }
async function mount(home: 'a' | 'b' = 'a') { screen = await renderScreen(root(home)); await waitForHomeGovernance(() => expect(screen?.findByTestId('restore-manual-secret-input')).not.toBeNull()); }
async function proveKey() {
    await act(async () => { screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(key); });
    await screen!.pressByTestIdAsync('restore-manual-submit');
}
async function primary(label = t('settingsAccount.nativePassword.setNewPassword')) {
    await waitForHomeGovernance(() => expect(screen!.findAllByType(RoundButton).some(node => node.props.title === label), screen!.getTextContent()).toBe(true));
    const button = screen!.findAllByType(RoundButton).find(node => node.props.title === label);
    expect(button).toBeDefined();
    await act(async () => { await button!.props.action(); });
}
async function replacePassword(wait = true) {
    await waitForHomeGovernance(() => expect(screen?.findByTestId('e2ee-password-recovery-password')).not.toBeNull());
    await act(async () => {
        screen!.findByTestId('e2ee-password-recovery-password')!.props.onChangeText(PASSWORD);
        screen!.findByTestId('e2ee-password-recovery-confirm')!.props.onChangeText(PASSWORD);
    });
    await primary();
    if (wait) await waitForHomeGovernance(() => expect(homes.requestsFor(CHANGE)).toHaveLength(1));
}
async function recoverOnHomeB() { await mount('b'); await proveKey(); await replacePassword(); }
beforeEach(async () => {
    // The host renderer cannot mount a DOM portal; retain its actual children.
    const portal = vi.spyOn(ReactDOM, 'createPortal').mockImplementation(children => children as React.ReactPortal);
    restorePortal = () => portal.mockRestore();
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
    homeAProfileId = await homes.addHome({ name: 'Home A', serverUrl: HOME_A_URL, serverIdentityId: 'srv_home_a', accountId: 'account-1', credentials: { token, secret: key }, accountEncryptionMode: 'e2ee' });
    homeBProfileId = await homes.addHome({ name: 'Home B', serverUrl: HOME_B_URL, serverIdentityId: 'srv_home_b', accountId: 'account-1', credentials: { token, secret: key }, accountEncryptionMode: 'e2ee', active: false });
    // Both Accounts exist on their Homes while this device holds neither credential.
    await TokenStorage.removeCredentialsForServerUrl(HOME_A_URL, { serverId: homeAProfileId });
    await TokenStorage.removeCredentialsForServerUrl(HOME_B_URL, { serverId: homeBProfileId });
    for (const [id, home] of [[homeAProfileId, 'a'], [homeBProfileId, 'b']] as const) {
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: `srv_home_${home}` }, auth: { keyChallenge: { v2: true } },
        } });
        homes.answer(id, '/v1/features', { body: features });
        homes.answer(id, '/v1/features/authenticated', { body: features });
        homes.answer(id, '/v1/auth/challenge', { body: challenge(home) });
        homes.answer(id, '/v1/auth', { body: { token } });
        answerSecurity(id); answerPreparation(id, home);
        homes.answer(id, CHANGE, { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'updated' }) });
        homes.answer(id, '/v1/account/encryption/currentness', { body: createLegacyAccountEncryptionCurrentnessFixture({ secret }) });
    }
    resetServerFeaturesClientForTests();
    installPasswordKdfWorkerBoundary();
    router.replace.mockClear(); router.back.mockClear();
});
afterEach(async () => {
    blockFocus = false;
    await screen?.unmount(); screen = null;
    await homes.reset(); local.restore();
    await standardCleanup();
    restorePortal?.(); restorePortal = null; vi.unstubAllGlobals();
});
it('can leave recovery before proving a key without authenticating or mutating anything', async () => {
    await mount(); await screen!.pressByTestIdAsync('unauth-shell-back-chevron');
    expect(router.back).toHaveBeenCalledOnce(); expect(homes.requestsFor('/v1/auth')).toHaveLength(0);
    expect(homes.requestsFor(PREPARE)).toHaveLength(0); expect(homes.requestsFor(CHANGE)).toHaveLength(0);
});
it('names the Home being recovered by its label, not its raw address', async () => {
    await mount(); expect(screen!.findHostByTestId('e2ee-password-recovery-home')?.props.accessibilityLabel).toBe('Home A');
    expect(screen!.findAll(node => node.props.children === HOME_A_URL)).toHaveLength(0);
});
it('replaces the E2EE password through one existing-Account key proof before persisting exact-Home credentials', async () => {
    await mount(); await proveKey();
    expect(homes.requestsFor('/v1/auth')).toHaveLength(1);
    expect(KeyChallengeV2AuthRequestSchema.parse(homes.requestsFor('/v1/auth')[0]?.input)).toMatchObject({ challengeId: 'challenge-a', requireExistingAccount: true });
    expect(await TokenStorage.getCredentialsForServerUrl(HOME_A_URL, { serverId: homeAProfileId })).toBeNull();
    await replacePassword();
    expect(PasswordMutationPreparationRequestV1Schema.parse(homes.requestsFor(PREPARE)[0]?.input)).toMatchObject({ action: 'recover', expectedCredentialRevision: 7, normalizedNativeEmail: 'person@example.test' });
    expect(AccountPasswordChangeRequestV1Schema.parse(homes.requestsFor(CHANGE)[0]?.input)).toMatchObject({ kind: 'e2ee', action: 'recover', expectedCredentialRevision: 7 });
    await waitForHomeGovernance(async () => expect(await TokenStorage.getCredentialsForServerUrl(HOME_A_URL, { serverId: homeAProfileId })).toEqual({ token, secret: key }));
    expect(homes.requestsFor(CHANGE)).toHaveLength(1); await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/'));
});
it('activates the exact recovered Home before showing its content, with another Home focused', async () => {
    await recoverOnHomeB(); await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeIdForIdentifier(homeBProfileId));
    await waitForHomeGovernance(async () => expect(await TokenStorage.getCredentialsForServerUrl(HOME_B_URL, { serverId: resolveServerProfileScopeIdForIdentifier(homeBProfileId) })).toEqual({ token, secret: key }));
});
it('stays on recovery with a retry when the recovered Home cannot be activated', async () => {
    blockFocus = true; await recoverOnHomeB();
    await waitForHomeGovernance(() => expect(screen?.findByTestId('e2ee-password-recovery-destination-home')?.props.accessibilityRole, screen!.getTextContent()).toBe('alert'));
    expect(router.replace).not.toHaveBeenCalled(); blockFocus = false; await primary(t('common.retry'));
    await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(homes.requestsFor(CHANGE)).toHaveLength(1);
});
it('does not expose password replacement or persist credentials for a Plain Account', async () => {
    answerSecurity(homeAProfileId, 'plain'); await mount(); await proveKey();
    expect(screen!.findByTestId('e2ee-password-recovery-password')).toBeNull(); expect(homes.requestsFor(PREPARE)).toHaveLength(0); expect(homes.requestsFor(CHANGE)).toHaveLength(0);
    expect(await TokenStorage.getCredentialsForServerUrl(HOME_A_URL, { serverId: homeAProfileId })).toBeNull();
});
it('keeps a rejected recovery key effect-free', async () => {
    homes.answer(homeAProfileId, '/v1/auth', { status: 401, body: { error: 'invalid-signature' } });
    await mount(); await proveKey();
    expect(screen!.findByTestId('e2ee-password-recovery-password')).toBeNull(); expect(homes.requestsFor(SECURITY)).toHaveLength(0);
    expect(homes.requestsFor(PREPARE)).toHaveLength(0); expect(homes.requestsFor(CHANGE)).toHaveLength(0);
    expect(await TokenStorage.getCredentialsForServerUrl(HOME_A_URL, { serverId: homeAProfileId })).toBeNull();
});
it('retires the proven Account when the person backs out before choosing a password', async () => {
    await mount(); await proveKey(); await waitForHomeGovernance(() => expect(screen?.findByTestId('e2ee-password-recovery-password')).not.toBeNull());
    await screen!.pressByTestIdAsync('unauth-shell-back-chevron');
    expect(screen!.findByTestId('restore-manual-secret-input')).not.toBeNull(); expect(screen!.findByTestId('e2ee-password-recovery-password')).toBeNull();
    expect(homes.requestsFor(PREPARE)).toHaveLength(0); expect(homes.requestsFor(CHANGE)).toHaveLength(0);
    expect(await TokenStorage.getCredentialsForServerUrl(HOME_A_URL, { serverId: homeAProfileId })).toBeNull();
});
it('retires password preparation before effects when the exact Home target changes', async () => {
    let release!: () => void;
    answerPreparation(homeAProfileId, 'a', new Promise<void>(resolve => { release = resolve; }));
    await mount(); await proveKey(); await replacePassword(false);
    await waitForHomeGovernance(() => expect(homes.requestsFor(PREPARE)).toHaveLength(1));
    await screen!.update(root('b')); await waitForHomeGovernance(() => expect(screen?.findByTestId('restore-manual-secret-input')).not.toBeNull());
    await act(async () => { release(); });
    expect(homes.requestsFor(CHANGE)).toHaveLength(0);
    expect(await TokenStorage.getCredentialsForServerUrl(HOME_A_URL, { serverId: homeAProfileId })).toBeNull();
});
