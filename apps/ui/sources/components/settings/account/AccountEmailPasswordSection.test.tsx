import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installPasswordKdfWorkerBoundary } from '@/dev/testkit/mocks/passwordKdfWorker';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import {
    ACCOUNT_SECURITY_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1, ACCOUNT_PASSWORD_ENROLL_PATH_V1,
    ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1, ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1,
    ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1, ACCOUNT_PASSWORD_REMOVE_PATH_V1,
    AccountSecurityGetResponseV1Schema, AccountPasswordChangeRequestV1Schema, AccountPasswordEnrollRequestV1Schema,
    AccountPasswordMutationResponseV1Schema, AccountPasswordEnrollEmailRequestV1Schema,
    AccountEmailChangeRequestV1Schema, AccountEmailChangeRequestResponseV1Schema, AccountSecurityServerErrorV1Schema,
    PasswordMutationPreparationRequestV1Schema, PasswordMutationPreparationResponseV1Schema,
} from '@happier-dev/protocol/auth/accountSecurity';
import { PlainAccountPasswordCredentialV1Schema, E2eeAccountPasswordCredentialV1Schema, encodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1, PasswordMutationChallengeV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { nativePasswordTranslations } from '@/text/translations/nativePasswordTranslations';

const native = vi.hoisted(() => ({ platform: 'web' as 'web' | 'ios', openURL: vi.fn(async () => {}), openAuthSession: vi.fn() }));
const nativeStorage = new Map<string, string>();
installTokenStorageWebPlatformMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return native.platform; } }, Linking: { openURL: native.openURL } });
}, secureStore: async () => ({
    getItemAsync: async (key: string) => nativeStorage.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { nativeStorage.set(key, value); },
    deleteItemAsync: async (key: string) => { nativeStorage.delete(key); },
}) });
installTokenStorageTestIsolation('account-email-password', { preserveGenerations: true });
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Native/browser auth-session SDK is the external provider window boundary.
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: native.openAuthSession }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { Modal } = await import('@/modal');
const { AccountEmailPasswordSection } = await import('./AccountEmailPasswordSection');
const { resetAccountSecurityProjectionStoreForTests } = await import('./accountSecurityProjectionStore');
const enrollment = await import('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth');

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let restoreStorage: () => void;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreExecutor: (() => void) | undefined;
let homeId: string;
const copy = nativePasswordTranslations.en;
const verificationToken = 'V'.repeat(43);
const password = 'correct horse battery staple';

function projection(mode: 'plain' | 'e2ee' = 'plain', enrolled = true, nativeEmail: string | null = enrolled ? 'person@example.test' : null) {
    return AccountSecurityGetResponseV1Schema.parse({
        v: 1, encryptionMode: mode, nativeEmail,
        password: enrolled ? { status: 'enrolled', revision: 4 } : { status: 'not_enrolled', revision: null },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(next => { resolve = next; });
    return { promise, resolve };
}

beforeEach(() => {
    resetAccountSecurityProjectionStoreForTests();
    native.platform = 'web';
    nativeStorage.clear();
    restoreStorage = installLocalStorageMock().restore;
    installPasswordKdfWorkerBoundary();
    native.openURL.mockClear();
    native.openAuthSession.mockReset().mockResolvedValue({ type: 'success',
        url: 'https://app.example.test/oauth/github?flow=auth&purpose=account_password_enrollment&pending=server-pending' });
    vi.mocked(Modal.show).mockClear();
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    enrollment.clearAccountPasswordEnrollmentExternalAuthCustody();
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    enrollment.clearAccountPasswordEnrollmentExternalAuthCustody();
    await connection?.dispose();
    connection = null;
    restoreExecutor?.();
    restoreExecutor = undefined;
    await homes.reset();
    restoreStorage();
    vi.unstubAllGlobals();
});

async function setupHome(mode: 'plain' | 'e2ee' = 'plain', enrolled = true, linked = false) {
    const credentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }),
        ...(mode === 'e2ee' ? { secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } : {}) };
    homeId = await homes.addHome({ name: 'Home A', serverUrl: 'https://home-a.example.test', serverIdentityId: 'srv_home_a',
        accountId: 'account-a', accountEncryptionMode: mode, credentials, currentAccount: true });
    homes.answer(homeId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    homes.answer(homeId, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: 'account-a', linkedProviders: linked ? [{
        id: 'github', login: 'person', displayName: 'Person', avatarUrl: null, profileUrl: null, showOnProfile: false,
    }] : [] }) });
    let currentProjection = projection(mode, enrolled);
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { select: () => ({ body: currentProjection }) });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_CHANGE_PATH_V1}`, { select: input => {
        const request = AccountPasswordChangeRequestV1Schema.parse(input);
        currentProjection = AccountSecurityGetResponseV1Schema.parse({ ...currentProjection,
            password: { status: 'enrolled', revision: request.expectedCredentialRevision + 1 } });
        return { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'updated' }) };
    } });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_ENROLL_PATH_V1}`, { select: input => {
        const request = AccountPasswordEnrollRequestV1Schema.parse(input);
        currentProjection = AccountSecurityGetResponseV1Schema.parse({ ...currentProjection,
            nativeEmail: request.email, password: { status: 'enrolled', revision: 1 } });
        return { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'enrolled' }) };
    } });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_REMOVE_PATH_V1}`, { select: () => {
        currentProjection = projection(mode, false);
        return { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'removed' }) };
    } });
    const sent = AccountEmailChangeRequestResponseV1Schema.parse({ v: 1, status: 'verification_sent' });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1}`, { body: sent });
    homes.answer(homeId, `POST ${ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1}`, { body: sent });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.example.test', serverIdentityId: 'srv_home_a', credentials,
        additionalRequestOrigins: ['https://home-b.example.test'], request: async (input, init) => {
            const response = await homes.request(input, init);
            const url = new URL(input instanceof Request ? input.url : String(input));
            return response.status === 404 ? createEmptyAccountBootstrapHttpResponse(url.pathname + url.search, init) ?? response : response;
        } });
    restoreExecutor = await installRealActionExecutorModuleLoader();
}

async function renderSection(props: React.ComponentProps<typeof AccountEmailPasswordSection> = {}, strict = false) {
    const section = <AccountEmailPasswordSection {...props} />;
    screen = await renderScreen(<AuthProvider initialCredentials={await TokenStorage.getCredentials()}>
        {strict ? <React.StrictMode>{section}</React.StrictMode> : section}
    </AuthProvider>);
    return screen;
}

async function openPasswordForm() {
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen!.pressByTestIdAsync('settings-account-password');
}

async function fillPasswords(current = true, email = false) {
    await act(async () => {
        if (email) screen?.changeTextByTestId('settings-account-password-enroll-email', 'Person@Example.test');
        if (current) screen?.changeTextByTestId('settings-account-current-password', 'previous horse battery staple');
        screen?.changeTextByTestId('settings-account-new-password', password);
        screen?.changeTextByTestId('settings-account-confirm-password', password);
    });
}

function answerPlainPreparation() {
    const targetCredential = PlainAccountPasswordCredentialV1Schema.parse({ v: 1, kind: 'plain_password_hash', hash: {
        v: 1, algorithm: 'scrypt', parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
        salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)), digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
    } });
    homes.answer(homeId, 'POST /v1/auth/entry', { body: AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null, actions: [{ kind: 'authenticate', methodId: 'github',
            action: 'login', mode: 'keyless', origin: 'home', presentation: { displayName: 'GitHub' } }],
    }) });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1}`, { select: input => {
        expect(PasswordMutationPreparationRequestV1Schema.parse(input)).toMatchObject({ action: 'connect', normalizedNativeEmail: 'person@example.test' });
        return { body: PasswordMutationPreparationResponseV1Schema.parse({ targetCredential }) };
    } });
    homes.answer(homeId, '/v1/auth/external/github/params', { body: { url: 'https://github.example.test/authorize' } });
    return targetCredential;
}

async function preparePlainCustody(claimCallback = true) {
    const targetCredential = answerPlainPreparation();
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw new Error('Missing signed-in Account');
    const target = { serverId: connection!.serverId, serverUrl: 'https://home-a.example.test' };
    const started = await enrollment.startAccountPasswordEnrollmentExternalAuth({
        accountId: 'account-a', currentCredentials: credentials, linkedProviderIds: ['github'],
        normalizedNativeEmail: 'person@example.test', newPassword: password,
        returnTo: `/settings/account/security?verificationToken=${verificationToken}`, target,
    });
    if (started.kind !== 'oauth') throw new Error('Expected provider ceremony');
    if (claimCallback) expect(enrollment.readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).not.toBeNull();
    await enrollment.resumeAccountPasswordEnrollmentExternalAuth({ provider: 'github', pending: 'server-pending', currentCredentials: credentials, target });
    return targetCredential;
}

it('loads the canonical projection and opens the enrolled Plain password form', async () => {
    await setupHome();
    await renderSection();
    await openPasswordForm();
    expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull();
    expect(screen?.findByTestId('settings-account-current-password')).not.toBeNull();
});

it('retires old Account work and never renders or republishes its projection after a Home switch', async () => {
    await setupHome();
    const pending = deferred<void>();
    homes.answer(homeId, `POST ${ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1}`, { respondAfter: pending.promise,
        body: AccountEmailChangeRequestResponseV1Schema.parse({ v: 1, status: 'verification_sent' }) });
    await renderSection();
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('person@example.test'));
    await screen!.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => { screen?.changeTextByTestId('settings-account-change-email-input', 'next@example.test'); });
    screen!.pressByTestId('settings-account-change-email-submit');
    await vi.waitFor(() => expect(homes.requestsFor(ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1)).toHaveLength(1));
    const other = await homes.addHome({ name: 'Home B', serverUrl: 'https://home-b.example.test', accountId: 'account-b', currentAccount: true, active: false });
    homes.answer(other, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: 'account-b' }) });
    homes.answer(other, ACCOUNT_SECURITY_PATH_V1, { body: projection('plain', true, 'bob@example.test') });
    await act(async () => {
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        await setActiveServerId(other, { scope: 'device' });
    });
    pending.resolve();
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('bob@example.test'));
    expect(screen?.getTextContent()).not.toContain('person@example.test');
    expect(screen?.findByTestId('settings-account-change-email-form')).toBeNull();
    expect(screen?.findByTestId('settings-account-pending-email-actions')).toBeNull();
});

it('remains alive through React StrictMode effect replay and publishes the current projection', async () => {
    await setupHome();
    const onProjection = vi.fn();
    await renderSection({ onProjection }, true);
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('person@example.test'));
    expect(onProjection).toHaveBeenCalledWith(projection());
});

it('submits first Plain enrollment only with the exact purpose-bound proof in real custody', async () => {
    await setupHome('plain', false, true);
    const targetCredential = await preparePlainCustody();
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordSetUp));
    expect(AccountPasswordEnrollRequestV1Schema.parse(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)[0]?.input)).toMatchObject({
        kind: 'plain', email: 'person@example.test', targetCredential, verificationToken,
        reauthentication: { provider: 'github', pending: 'server-pending', proof: expect.any(String) },
    });
    expect(homes.requestsFor(ACCOUNT_PASSWORD_CHANGE_PATH_V1)).toHaveLength(0);
    expect(await enrollment.readAccountPasswordEnrollmentExternalAuthProof({ accountId: 'account-a',
        currentCredentials: connection!.credentials, target: { serverId: connection!.serverId, serverUrl: 'https://home-a.example.test' } })).toBeNull();
});

// A present-user invocation uses the native Ask decision. Fabricating an Inbox
// continuation here bypassed the Action executor and asserted an unreachable lifecycle.
it.each([true, false])('honors the real Ask decision (%s) without replaying Plain enrollment', async approved => {
    await setupHome('plain', false, true);
    await homes.requireUiApproval(homeId, 'account.password.enroll');
    vi.mocked(Modal.confirm).mockResolvedValue(approved);
    await preparePlainCustody();
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalled());
    if (approved) await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordSetUp));
    else await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-submit')?.props.disabled).not.toBe(true));
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(approved ? 1 : 0);
    expect(homes.requestsFor('/v1/artifacts').filter(row => row.method === 'POST')).toHaveLength(0);
});

it('consumes a mounted proof once and clears failed reauthentication without looping', async () => {
    await setupHome('plain', false, true);
    await preparePlainCustody();
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_ENROLL_PATH_V1}`, { status: 403,
        body: AccountSecurityServerErrorV1Schema.parse({ error: 'reauthentication_required' }) });
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password-form-error')).not.toBeNull());
    await act(async () => {});
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(1);
    expect(await enrollment.readAccountPasswordEnrollmentExternalAuthProof({ accountId: 'account-a', currentCredentials: connection!.credentials,
        target: { serverId: connection!.serverId, serverUrl: 'https://home-a.example.test' } })).toBeNull();
});

it('does not auto-submit after reload when process-local enrollment custody is absent', async () => {
    await setupHome('plain', false);
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')).not.toBeNull());
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(0);
});

it('retires unclaimed custody on unmount before the projection resolves', async () => {
    await setupHome('plain', false, true);
    await preparePlainCustody(false);
    // Hold the projection so the mounted automatic continuation cannot consume custody.
    const ready = deferred<void>();
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { body: projection('plain', false), respondAfter: ready.promise });
    await renderSection({ verificationToken });
    await screen!.unmount(); screen = null;
    await act(async () => { ready.resolve(); });
    expect(await enrollment.readAccountPasswordEnrollmentExternalAuthProof({ accountId: 'account-a', currentCredentials: connection!.credentials,
        target: { serverId: connection!.serverId, serverUrl: 'https://home-a.example.test' } })).toBeNull();
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(0);
});

it('retires callback-claimed custody when the user cancels enrollment', async () => {
    await setupHome('plain', false, true);
    answerPlainPreparation();
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')).not.toBeNull());
    await fillPasswords(false, true);
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password-enrollment-continue')).not.toBeNull());
    const claimed = enrollment.readAccountPasswordEnrollmentExternalAuthCallbackContext('github');
    expect(claimed).not.toBeNull();
    await screen!.pressByTestIdAsync('settings-account-password-form-cancel');

    expect(enrollment.readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toBeNull();
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(0);
});

it('cancels an in-flight preparation before it can dispatch enrollment', async () => {
    await setupHome('plain', false, true);
    const targetCredential = answerPlainPreparation();
    const pending = deferred<void>();
    let signal: AbortSignal | null | undefined;
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1}`, { select: (_input, request) => {
        signal = request.signal;
        return { respondAfter: pending.promise, body: PasswordMutationPreparationResponseV1Schema.parse({ targetCredential }) };
    } });
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')).not.toBeNull());
    await fillPasswords(false, true);
    screen!.pressByTestId('settings-account-change-password-submit');
    await vi.waitFor(() => expect(homes.requestsFor(ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1)).toHaveLength(1));
    await screen!.pressByTestIdAsync('settings-account-password-form-cancel');
    await act(async () => { pending.resolve(); });

    expect(signal?.aborted).toBe(true);
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(0);
    expect(screen?.findByTestId('settings-account-change-password-form')).toBeNull();
});

it('aborts dispatched enrollment on unmount and retires process-local custody', async () => {
    await setupHome('plain', false, true);
    await preparePlainCustody();
    const pending = deferred<void>();
    let signal: AbortSignal | null | undefined;
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_ENROLL_PATH_V1}`, { select: (_input, request) => {
        signal = request.signal;
        return { respondAfter: pending.promise, body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'enrolled' }) };
    } });
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(1));
    await screen!.unmount(); screen = null;
    await act(async () => { pending.resolve(); });
    expect(signal?.aborted).toBe(true);
});

it('opens web OAuth only from the direct continuation gesture and settles in the same custody owner', async () => {
    await setupHome('plain', false, true);
    answerPlainPreparation();
    vi.stubGlobal('window', { location: { origin: 'https://app.example.test' }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')).not.toBeNull());
    await fillPasswords(false, true);
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password-enrollment-continue')).not.toBeNull());
    expect(native.openAuthSession).not.toHaveBeenCalled();
    expect(screen?.findByTestId('settings-account-new-password')?.props.editable).toBe(false);
    await screen!.pressByTestIdAsync('settings-account-password-enrollment-continue');
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordSetUp));
    expect(native.openAuthSession).toHaveBeenCalledWith('https://github.example.test/authorize', 'https://app.example.test/oauth/github');
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(1);
});

it('unlocks the web enrollment form for a fresh preparation after the auth popup closes', async () => {
    await setupHome('plain', false, true);
    answerPlainPreparation();
    native.openAuthSession.mockResolvedValue({ type: 'cancel' });
    vi.stubGlobal('window', { location: { origin: 'https://app.example.test' }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')).not.toBeNull());
    await fillPasswords(false, true);
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password-enrollment-continue')).not.toBeNull());
    await screen!.pressByTestIdAsync('settings-account-password-enrollment-continue');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')?.props.editable).toBe(true));
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(0);
});

it.each(['plain', 'e2ee'] as const)('requests exact-Account mailbox verification before first %s password enrollment', async mode => {
    await setupHome(mode, false);
    await renderSection();
    await openPasswordForm();
    expect(screen?.findByTestId('settings-account-new-password')).toBeNull();
    expect(screen?.findByTestId('settings-account-confirm-password')).toBeNull();
    await act(async () => { screen?.changeTextByTestId('settings-account-password-enroll-email', 'Person@Example.test'); });
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-pending-email-actions')).not.toBeNull());
    const request = homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1)[0]!;
    expect(AccountPasswordEnrollEmailRequestV1Schema.parse(request.input)).toEqual({ v: 1, email: 'person@example.test' });
    expect(request.token).toBe(connection!.credentials.token);
    expect(homes.requestsFor(ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1)).toHaveLength(0);
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(0);
    expect(screen?.getTextContent()).toContain('p•••••@example.test');
    expect(screen?.getTextContent()).not.toContain('person@example.test');
});

it('opens the first-password enrollment form for an explicit Connect continuation', async () => {
    await setupHome('plain', false);
    await renderSection({ connectIntent: true });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password-enroll-email')).not.toBeNull());
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1)).toHaveLength(0);
});

it('carries the mailbox verification bearer and stable Home audience through real E2EE enrollment preparation', async () => {
    await setupHome('e2ee', false);
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1}`, { select: input => {
        const request = PasswordMutationPreparationRequestV1Schema.parse(input);
        if (!('newE2eePassword' in request)) throw new Error('Expected locally prepared envelope');
        const targetCredential = E2eeAccountPasswordCredentialV1Schema.parse({ v: 1, kind: 'e2ee_password_envelope', envelope: request.newE2eePassword.envelope,
            authVerifier: { v: 1, hash: { v: 1, algorithm: 'scrypt', parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)), digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)) } } });
        return { body: PasswordMutationPreparationResponseV1Schema.parse({ targetCredential, challenge: PasswordMutationChallengeV1Schema.parse({
            v: 1, challengeId: 'enroll-challenge', nonce: 'nonce', issuedAt: '2026-11-17T10:00:00.000Z', expiresAt: '2026-11-17T10:05:00.000Z',
            audience: { origin: 'https://home-a.example.test', serverIdentityId: 'srv_home_a' }, expectedAccountId: 'account-a',
            operationKind: 'password_credential_mutation_v1', operationDigest: createPasswordCredentialMutationDigestV1({
                v: 1, action: 'connect', accountId: 'account-a', expectedCredentialRevision: null, normalizedNativeEmail: 'person@example.test',
                newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
            }),
        }) }) };
    } });
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')).not.toBeNull());
    await fillPasswords(false, true);
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordSetUp));
    expect(AccountPasswordEnrollRequestV1Schema.parse(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)[0]?.input))
        .toMatchObject({ kind: 'e2ee', verificationToken, proof: { challengeId: 'enroll-challenge' } });
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1)).toHaveLength(0);
    expect(JSON.stringify(homes.requests)).not.toContain(password);
});

it('echoes a requested sign-in email change only as a masked address', async () => {
    await setupHome();
    await renderSection();
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    await screen!.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => { screen?.changeTextByTestId('settings-account-change-email-input', 'Next.Person@Example.test'); });
    await screen!.pressByTestIdAsync('settings-account-change-email-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-pending-email-actions')).not.toBeNull());
    expect(AccountEmailChangeRequestV1Schema.parse(homes.requestsFor(ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1)[0]?.input))
        .toEqual({ v: 1, email: 'Next.Person@example.test' });
    expect(screen?.getTextContent()).toContain('n••••••••••@example.test');
    expect(screen?.getTextContent()).not.toContain('Next.Person@example.test');
});

it('confirms a completed Plain password change and clears its confirmation when the form reopens', async () => {
    await setupHome();
    await renderSection();
    await openPasswordForm();
    await fillPasswords();
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordChanged));
    expect(screen?.findByTestId('settings-account-change-password-form')).toBeNull();
    expect(AccountPasswordChangeRequestV1Schema.parse(homes.requestsFor(ACCOUNT_PASSWORD_CHANGE_PATH_V1)[0]?.input))
        .toMatchObject({ kind: 'plain', expectedCredentialRevision: 4, currentPassword: 'previous horse battery staple', newPassword: password });
    await screen!.pressByTestIdAsync('settings-account-password');
    expect(screen?.findByTestId('settings-account-password-outcome')).toBeNull();
});

it('uses the native provider launcher and consumes the callback proof on the returning Account surface', async () => {
    native.platform = 'ios';
    await setupHome('plain', false, true);
    answerPlainPreparation();
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-new-password')).not.toBeNull());
    await fillPasswords(false, true);
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(native.openURL).toHaveBeenCalledWith('https://github.example.test/authorize'));
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(0);
    // Native linking routes resume the real process-local custody owner.
    expect(enrollment.readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).not.toBeNull();
    await enrollment.resumeAccountPasswordEnrollmentExternalAuth({ provider: 'github', pending: 'server-pending', currentCredentials: connection!.credentials,
        target: { serverId: connection!.serverId, serverUrl: 'https://home-a.example.test' } });
    await screen!.unmount(); screen = null;
    await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordSetUp));
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_PATH_V1)).toHaveLength(1);
});

it('keeps the section and its rows in place while the projection loads', async () => {
    await setupHome();
    const pending = deferred<void>();
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { body: projection(), respondAfter: pending.promise });
    await renderSection();
    expect(screen?.findHostByTestId('settings-account-security-loading')?.props.accessibilityState).toEqual({ busy: true });
    expect(screen?.findHostByTestId('settings-account-security-loading-skeleton:1')).not.toBeNull();
    await act(async () => { pending.resolve(); });
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('person@example.test'));
    expect(screen?.findByTestId('settings-account-security-loading')).toBeNull();
});

it('keeps the unavailable row on screen while a retry is in flight', async () => {
    await setupHome();
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { dispatchThenFail: true });
    await renderSection();
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-security-unavailable')).not.toBeNull());
    const pending = deferred<void>();
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { body: projection(), respondAfter: pending.promise });
    await act(async () => { screen?.pressByTestId('settings-account-security-unavailable-retry'); });
    expect(screen?.findByTestId('settings-account-security-unavailable')).not.toBeNull();
    await act(async () => { pending.resolve(); });
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('person@example.test'));
    expect(screen?.findByTestId('settings-account-security-unavailable')).toBeNull();
});

it('shows a mailbox-first failure even though that step has no password field', async () => {
    await setupHome('plain', false);
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1}`, { status: 503,
        body: AccountSecurityServerErrorV1Schema.parse({ error: 'email_delivery_unavailable' }) });
    await renderSection(); await openPasswordForm();
    await act(async () => { screen?.changeTextByTestId('settings-account-password-enroll-email', 'person@example.test'); });
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password-form-error')).not.toBeNull());
    expect(screen?.findByTestId('settings-account-new-password')).toBeNull();
});

it('submits the password form from the keyboard on the last field', async () => {
    await setupHome(); await renderSection(); await openPasswordForm(); await fillPasswords();
    await act(async () => { screen?.findHostByTestId('settings-account-confirm-password')?.props.onSubmitEditing?.(); });
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordChanged));
    expect(homes.requestsFor(ACCOUNT_PASSWORD_CHANGE_PATH_V1)).toHaveLength(1);
});

it('submits the sign-in email form from the keyboard', async () => {
    await setupHome(); await renderSection();
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    await screen!.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => { screen?.changeTextByTestId('settings-account-change-email-input', 'next@example.test'); });
    await act(async () => { screen?.findHostByTestId('settings-account-change-email-input')?.props.onSubmitEditing?.(); });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-pending-email-actions')).not.toBeNull());
    expect(homes.requestsFor(ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1)).toHaveLength(1);
});

it('shows one credential problem on its form while a separate address is pending', async () => {
    await setupHome();
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_CHANGE_PATH_V1}`, { status: 403,
        body: AccountSecurityServerErrorV1Schema.parse({ error: 'authentication_failed' }) });
    await renderSection();
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    await screen!.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => { screen?.changeTextByTestId('settings-account-change-email-input', 'next@example.test'); });
    await screen!.pressByTestIdAsync('settings-account-change-email-submit');
    await openPasswordForm(); await fillPasswords();
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    expect(await TokenStorage.getCredentialsForServerUrl('https://home-a.example.test', { serverId: connection!.serverId }))
        .toMatchObject({ token: connection!.credentials.token });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-current-password-error')).not.toBeNull());
    expect(screen?.getTextContent().split(copy.signInFailed).length).toBe(2);
    expect(screen?.findByTestId('settings-account-pending-email-actions')).not.toBeNull();
});

it('runs the one mailbox-first setup from the email row when there is no sign-in email', async () => {
    await setupHome('e2ee', false); await renderSection();
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    expect(screen?.getTextContent()).toContain(copy.passwordNeedsEmail);
    await screen!.pressByTestIdAsync('settings-account-sign-in-email');
    expect(screen?.findByTestId('settings-account-change-email-form')).toBeNull();
    const emailRow = screen?.findByTestId('settings-account-sign-in-email-row');
    expect(emailRow?.findAll(node => node.props.testID === 'settings-account-password-enroll-email').length).toBeGreaterThan(0);
    await act(async () => { screen?.changeTextByTestId('settings-account-password-enroll-email', 'person@example.test'); });
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-pending-email-actions')).not.toBeNull());
    expect(homes.requestsFor(ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1)).toHaveLength(0);
    expect(homes.requestsFor(ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1)).toHaveLength(1);
});

it('continues the setup at the password step in the email row after the confirmation link', async () => {
    await setupHome('e2ee', false); await renderSection({ verificationToken });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());
    const emailRow = screen?.findByTestId('settings-account-sign-in-email-row');
    expect(emailRow?.findAll(node => node.props.testID === 'settings-account-new-password').length).toBeGreaterThan(0);
});
