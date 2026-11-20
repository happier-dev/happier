import * as React from 'react';
import ReactDOM from 'react-dom';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthEntryProjectionV1Schema, AuthEntryRequestV1Schema } from '@happier-dev/protocol/auth/entry';
import { NativeAuthBearerPreviewRequestV1Schema, NativeEmailVerifyPreviewResponseV1Schema, NativePasswordResetPreviewResponseV1Schema, NativeEmailPasswordProvisionRequestV1Schema, NativeEmailPasswordProvisionResponseV1Schema, NativeEmailPasswordLoginResponseV1Schema, NativeEmailPasswordPreloginResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { AccountEmailChangeCompleteRequestV1Schema, AccountPasswordMutationResponseV1Schema, PlainPasswordResetSubmitRequestV1Schema, PlainPasswordResetSubmitResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { maskEmailForNativeAuthPreview } from '@happier-dev/protocol/auth/nativeAuthOneTimeOperation';
import { createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installTokenStorageTestIsolation } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { rememberNativeEmailVerificationContinuation, readNativeEmailVerificationContinuation, clearNativeEmailVerificationContinuation } from '@/sync/api/auth/nativeAuthEmail';
import { listServerProfiles, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { teamInvitationPreviewFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
installTokenStorageTestIsolation('native-email-landings', { preserveGenerations: true });
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const browser = await installBrowserRuntimeForTests({ url: 'https://device.example.test' });
afterAll(() => browser.restore());
await initializeAuthRouteRuntimeForTests();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { NativeAuthEmailVerifyScreen, NativeAuthPasswordResetScreen } = await import('./NativeAuthLandingScreens');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const VERIFY = 'V'.repeat(43);
const RESET = 'R'.repeat(43);
const OLD = 'O'.repeat(43);
const NEW = 'N'.repeat(43);
const SAVED_HOME_URL = 'https://saved.example.test';
const SAVED_HOME_IDENTITY = 'srv_saved_home';
const FRESH_HOME_URL = 'https://fresh.example.test';
const FRESH_HOME_IDENTITY = 'srv_fresh_home';
const PREVIEW = '/v1/auth/email/verify/preview';
const RESET_PREVIEW = '/v1/auth/password/reset/preview';
const RESET_REQUEST = '/v1/auth/password/reset/request';
const RESET_SUBMIT = '/v1/auth/password/reset/submit';
const EMAIL_CHANGE = '/v1/account/email/change';
const ENTRY = '/v1/auth/entry';
const PROVISION = '/v1/auth/email/provision';
const LOGIN = '/v1/auth/email/login';
const PASSWORD = 'correct horse battery staple';
const MASKED_EMAIL = maskEmailForNativeAuthPreview('person@example.test');
const token = createAccountTokenForTests('account-a');
let savedHomeProfileId = '';
let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let local: ReturnType<typeof installLocalStorageMock>;
let blockFocus = false;
let restorePortal: (() => void) | null = null;

function currentLinkCarrier(identity: string, url: string): string {
    return JSON.stringify({ kind: 'descriptor', authority: 'trusted_enrollment', descriptor: {
        v: 1, homeServerIdentityId: identity, canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }],
    } });
}
function currentContinuation() {
    return readNativeEmailVerificationContinuation({ homeServerIdentityId: SAVED_HOME_IDENTITY, maskedDestination: MASKED_EMAIL });
}
function preview(continuation: 'account_admission' | 'password_enrollment' | 'sign_in_email_change' | null = 'account_admission', valid = true, extra: Partial<HomeDomainAnswer> = {}) {
    homes.answer(savedHomeProfileId, PREVIEW, { body: NativeEmailVerifyPreviewResponseV1Schema.parse({ v: 1, valid, maskedDestination: valid ? MASKED_EMAIL : null, continuation }), ...extra });
}
function answerEntry(options: { failOnce?: boolean; publicClosed?: boolean } = {}) {
    let fail = options.failOnce ?? false;
    homes.answer(savedHomeProfileId, ENTRY, { select: input => {
        const request = AuthEntryRequestV1Schema.parse(input);
        if (fail) { fail = false; return { status: 503, body: { error: 'unavailable' } }; }
        const provision = { kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyless', origin: 'home', presentation: { displayName: 'Email and password' } };
        const login = { ...provision, action: 'login', passwordReset: 'email' };
        const invitation = teamInvitationPreviewFixture({ home: { serverId: SAVED_HOME_IDENTITY }, team: { teamId: 'team-a', name: 'Team A' } });
        return { body: AuthEntryProjectionV1Schema.parse(request.scope.kind === 'invitation' ? {
            v: 1, scope: { kind: 'invitation' }, state: 'admission_required', home: invitation.home,
            team: { teamId: invitation.team.teamId, name: invitation.team.name, logo: invitation.team.logo },
            invitationEmailVerificationRequired: true, autoRedirect: null, actions: [{ ...provision, origin: 'team' }],
        } : {
            v: 1, scope: { kind: 'home' }, state: 'ready', autoRedirect: null,
            actions: options.publicClosed && request.scope.kind === 'home' ? [] : [login, provision],
        }) };
    } });
}
function root(child: React.ReactNode) { return <AuthProvider initialCredentials={null}>{child}</AuthProvider>; }
async function mountVerify(options: { bearer?: string; home?: string | null } = {}) {
    screen = await renderScreen(root(<NativeAuthEmailVerifyScreen token={options.bearer ?? VERIFY} homeTarget={options.home === undefined ? SAVED_HOME_IDENTITY : options.home} />));
}
async function mountReset(bearer = RESET, home: string | null = SAVED_HOME_IDENTITY) {
    screen = await renderScreen(root(<NativeAuthPasswordResetScreen token={bearer} homeTarget={home} />));
}
async function waitForId(id: string) { await waitForHomeGovernance(() => expect(screen?.findByTestId(id), id).not.toBeNull()); }
async function openProvision() {
    await waitForId('native-auth-verify-create-account');
    await screen!.pressByTestIdAsync('native-auth-verify-create-account');
    await waitForId('home-auth-email_password-provision-keyless');
    await screen!.pressByTestIdAsync('home-auth-email_password-provision-keyless');
    await waitForId('email-password-password');
}
async function fill(id: string, value: string) { await act(async () => { screen!.findByTestId(id)!.props.onChangeText(value); }); }
async function waitForDestination() {
    await waitForHomeGovernance(() => expect(
        router.replace.mock.calls.length > 0
            || screen!.findByTestId('native-auth-verify-destination-home-error') !== null
            || screen!.findByTestId('native-auth-reset-destination-home-error') !== null,
        screen!.getTextContent(),
    ).toBe(true));
}
async function createAccount(teamId: string | null = null) {
    homes.answer(savedHomeProfileId, PROVISION, { body: NativeEmailPasswordProvisionResponseV1Schema.parse({ token, accountId: 'account-a', teamId }) });
    await fill('email-password-email', 'person@example.test');
    await fill('email-password-password', PASSWORD);
    await fill('email-password-confirm', PASSWORD);
    await screen!.pressByTestIdAsync('email-password-create');
    await waitForDestination();
}
async function submitReset(wait = true) {
    await waitForId('native-auth-reset-password');
    await fill('native-auth-reset-password', PASSWORD);
    await fill('native-auth-reset-confirm', PASSWORD);
    if (wait) await screen!.pressByTestIdAsync('native-auth-reset-submit');
    else {
        await act(async () => { screen!.pressByTestId('native-auth-reset-submit'); });
        await waitForHomeGovernance(() => expect(homes.requestsFor(RESET_SUBMIT)).toHaveLength(1));
    }
}
async function chooseLoginMethod() {
    await waitForId('home-auth-email_password-login-keyless');
    await screen!.pressByTestIdAsync('home-auth-email_password-login-keyless');
    await waitForId('email-password-email');
}
async function openResetLogin() { await submitReset(); await waitForId('native-auth-reset-sign-in'); await screen!.pressByTestIdAsync('native-auth-reset-sign-in'); await chooseLoginMethod(); }
async function submitLogin() {
    if (!screen!.findByTestId('email-password-email')) await chooseLoginMethod();
    await waitForId('email-password-email');
    await fill('email-password-email', 'person@example.test');
    await fill('email-password-password', PASSWORD);
    await screen!.pressByTestIdAsync('email-password-submit');
    await waitForDestination();
}
async function bound() { await homes.switchAccount(savedHomeProfileId, 'account-a'); }
function expectSecurity(verificationToken?: string) {
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/settings/account/security', params: { serverId: savedHomeProfileId, ...(verificationToken ? { verificationToken } : {}) } });
}
beforeEach(async () => {
    // The host renderer cannot mount a DOM portal; retain its actual children.
    const portal = vi.spyOn(ReactDOM, 'createPortal').mockImplementation(children => children as React.ReactPortal);
    restorePortal = () => portal.mockRestore();
    browser.activate();
    local = installLocalStorageMock();
    blockFocus = false;
    local.setItemMock.mockImplementation((key, value) => {
        const previous = local.store.get(key);
        if (blockFocus && key.includes('server-profiles') && previous
            && JSON.parse(value).activeServerId !== JSON.parse(previous).activeServerId) throw new Error('Device storage unavailable');
        local.store.set(key, value);
    });
    await homes.reset();
    savedHomeProfileId = await homes.addHome({ name: 'Saved Home', serverUrl: SAVED_HOME_URL, serverIdentityId: SAVED_HOME_IDENTITY, accountId: 'account-a', credentials: { token } });
    // The authenticated HTTP responses own an Account; this device starts signed out.
    await TokenStorage.removeCredentialsForServerUrl(SAVED_HOME_URL, { serverId: savedHomeProfileId });
    await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example.test', serverIdentityId: 'srv_focused_home', accountId: null });
    preview();
    answerEntry();
    homes.answer(savedHomeProfileId, RESET_PREVIEW, { body: NativePasswordResetPreviewResponseV1Schema.parse({ v: 1, valid: true }) });
    homes.answer(savedHomeProfileId, RESET_SUBMIT, { body: PlainPasswordResetSubmitResponseV1Schema.parse({ v: 1, status: 'password_reset' }) });
    homes.answer(savedHomeProfileId, EMAIL_CHANGE, { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'updated' }) });
    homes.answer(savedHomeProfileId, '/v1/auth/email/prelogin', { body: NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' }) });
    homes.answer(savedHomeProfileId, LOGIN, { body: NativeEmailPasswordLoginResponseV1Schema.parse({ token }) });
    router.replace.mockClear();
});
afterEach(async () => {
    blockFocus = false;
    await screen?.unmount(); screen = null;
    const continuation = currentContinuation();
    if (continuation) clearNativeEmailVerificationContinuation(continuation);
    await homes.reset();
    local.restore();
    await standardCleanup();
    restorePortal?.(); restorePortal = null;
});

it('continues a verified mailbox proof into the exact Home provision controller without losing its bearer', async () => {
    await mountVerify(); await openProvision();
    expect(screen!.findByTestId('unauth-shell-native-auth-verify')).not.toBeNull();
    await createAccount();
    expect(NativeEmailPasswordProvisionRequestV1Schema.parse(homes.requestsFor(PROVISION)[0]?.input).admission).toEqual({ kind: 'native_email_verification', token: VERIFY });
    expect(homes.requestsFor(PROVISION)[0]?.serverId).toBe(savedHomeProfileId);
    expect(NativeAuthBearerPreviewRequestV1Schema.parse(homes.requestsFor(PREVIEW)[0]?.input).token).toBe(VERIFY);
});
it('retries authentication discovery after a valid verification preview without replaying the preview', async () => {
    answerEntry({ failOnce: true }); await mountVerify(); await waitForId('native-auth-verify-retry-auth');
    await screen!.pressByTestIdAsync('native-auth-verify-retry-auth'); await openProvision();
    expect(homes.requestsFor(PREVIEW)).toHaveLength(1);
    expect(homes.requestsFor(ENTRY)).toHaveLength(2);
});
it('opens a mailed link as a step of the welcome split, not a bare page', async () => {
    await mountReset(); await waitForId('native-auth-reset-password');
    expect(screen!.findByTestId('unauth-shell-native-auth-reset')).not.toBeNull();
    expect(screen!.findByTestId('native-auth-reset-title')).not.toBeNull();
});
it('recovers sign-in discovery after a completed reset without resetting the password again', async () => {
    answerEntry({ failOnce: true }); await mountReset(); await submitReset(); await waitForId('native-auth-reset-retry-auth');
    await screen!.pressByTestIdAsync('native-auth-reset-retry-auth');
    await screen!.pressByTestIdAsync('native-auth-reset-sign-in'); await chooseLoginMethod();
    expect(homes.requestsFor(RESET_SUBMIT)).toHaveLength(1); expect(homes.requestsFor(RESET_PREVIEW)).toHaveLength(1);
});
it('resumes transferable invitation provision with the unchanged admission and exact mailbox bearer', async () => {
    const admission = { kind: 'team_invitation' as const, token: 'I'.repeat(43) };
    rememberNativeEmailVerificationContinuation({ homeServerIdentityId: SAVED_HOME_IDENTITY, normalizedEmail: 'person@example.test', admission });
    await mountVerify(); await openProvision(); await createAccount();
    expect(NativeEmailPasswordProvisionRequestV1Schema.parse(homes.requestsFor(PROVISION)[0]?.input).admission).toEqual({ ...admission, emailVerificationToken: VERIFY });
    expect(currentContinuation()).toBeNull();
});
it('brings the mailbox it just verified back to self-service Account creation', async () => {
    rememberNativeEmailVerificationContinuation({ homeServerIdentityId: SAVED_HOME_IDENTITY, normalizedEmail: 'person@example.test' });
    await mountVerify(); await openProvision();
    expect(screen!.findByTestId('email-password-email')?.props.value).toBe('person@example.test');
});
it('uses invitation-scoped admission actions when the ordinary Home is invitation-only', async () => {
    const admission = { kind: 'team_invitation' as const, token: 'I'.repeat(43) };
    rememberNativeEmailVerificationContinuation({ homeServerIdentityId: SAVED_HOME_IDENTITY, normalizedEmail: 'person@example.test', admission });
    answerEntry({ publicClosed: true }); await mountVerify(); await openProvision();
    expect(AuthEntryRequestV1Schema.parse(homes.requestsFor(ENTRY)[0]?.input).scope).toEqual({ kind: 'invitation', token: admission.token });
    expect(homes.requestsFor(ENTRY)[0]?.serverId).toBe(savedHomeProfileId);
});
it('uses the verification-scoped entry after a fresh-document invitation link and routes its Team result', async () => {
    answerEntry({ publicClosed: true }); await mountVerify(); await openProvision(); await createAccount('team-a');
    expect(AuthEntryRequestV1Schema.parse(homes.requestsFor(ENTRY)[0]?.input).scope).toEqual({ kind: 'native_email_verification', token: VERIFY });
    expect(router.replace).toHaveBeenCalledWith(`/settings/teams/${SAVED_HOME_IDENTITY}/team-a`);
});
it('signs in to the carried Home before continuing password enrollment with the same bearer', async () => {
    preview('password_enrollment'); await mountVerify(); await waitForId('native-auth-verify-sign-in');
    await screen!.pressByTestIdAsync('native-auth-verify-sign-in'); await submitLogin();
    expect(homes.requestsFor(EMAIL_CHANGE)).toHaveLength(0); expectSecurity(VERIFY);
    expect(homes.requestsFor(LOGIN)[0]?.serverId).toBe(savedHomeProfileId);
});
it('fails closed without a portable Home target and never previews the bearer against the focused Home', async () => {
    await mountVerify({ home: null }); await waitForId('native-auth-verify-invalid'); expect(homes.requestsFor(PREVIEW)).toHaveLength(0);
});
it('fails a password-reset landing closed when the Home profile cannot be resolved', async () => {
    await mountReset(RESET, null); await waitForId('native-auth-reset-invalid'); expect(homes.requestsFor(RESET_PREVIEW)).toHaveLength(0);
});
it('opens password reset recovery on the exact Home named by an expired link', async () => {
    homes.answer(savedHomeProfileId, RESET_PREVIEW, { body: NativePasswordResetPreviewResponseV1Schema.parse({ v: 1, valid: false }) });
    homes.answer(savedHomeProfileId, RESET_REQUEST, { body: { v: 1, accepted: true } });
    await mountReset();
    await waitForId('native-auth-reset-request-new-link');
    expect(screen!.getTextContent()).toContain('Saved Home');
    await screen!.pressByTestIdAsync('native-auth-reset-request-new-link');
    await waitForId('email-password-request-reset');
    expect(screen!.getTextContent()).toContain('Saved Home');
    await fill('email-password-email', 'person@example.test');
    await screen!.pressByTestIdAsync('email-password-request-reset');
    const [request] = homes.requestsFor(RESET_REQUEST);
    expect(request?.serverId).toBe(savedHomeProfileId);
    expect(request?.input).toEqual({ v: 1, email: 'person@example.test' });
    expect(getActiveServerSnapshot().serverUrl).not.toBe('https://saved.example.test');
    expect(homes.requestsFor(RESET_PREVIEW)).toHaveLength(1);
    expect(homes.requestsFor(RESET_SUBMIT)).toHaveLength(0);
});
it('authenticates a signed-out email-change recipient against the carried Home and consumes the bearer only in the owning mutation', async () => {
    preview('sign_in_email_change'); await mountVerify(); await waitForId('native-auth-verify-sign-in');
    expect(homes.requestsFor(EMAIL_CHANGE)).toHaveLength(0);
    await screen!.pressByTestIdAsync('native-auth-verify-sign-in'); await submitLogin();
    expect(AccountEmailChangeCompleteRequestV1Schema.parse(homes.requestsFor(EMAIL_CHANGE)[0]?.input)).toEqual({ v: 1, verificationToken: VERIFY });
    expect(homes.requestsFor(EMAIL_CHANGE)[0]?.token).toBe(token); expectSecurity();
});
it('makes a previous verification preview inert while a replacement bearer is being checked', async () => {
    preview('sign_in_email_change'); await mountVerify({ bearer: OLD }); await waitForId('native-auth-verify-sign-in');
    let release!: () => void;
    preview(null, false, { respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    await screen!.update(root(<NativeAuthEmailVerifyScreen token={NEW} homeTarget={SAVED_HOME_IDENTITY} />));
    expect(screen!.findByTestId('native-auth-verify-sign-in')).toBeNull();
    await act(async () => { release(); }); await waitForId('native-auth-verify-invalid');
    expect(NativeAuthBearerPreviewRequestV1Schema.parse(homes.requestsFor(PREVIEW).at(-1)?.input).token).toBe(NEW);
    expect(homes.requestsFor(EMAIL_CHANGE)).toHaveLength(0);
});
it('makes the old reset form inert while a replacement bearer is being checked', async () => {
    await mountReset(OLD); await waitForId('native-auth-reset-password');
    let release!: () => void;
    homes.answer(savedHomeProfileId, RESET_PREVIEW, { body: NativePasswordResetPreviewResponseV1Schema.parse({ v: 1, valid: false }), respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    await screen!.update(root(<NativeAuthPasswordResetScreen token={NEW} homeTarget={SAVED_HOME_IDENTITY} />));
    expect(screen!.findByTestId('native-auth-reset-password')).toBeNull();
    await act(async () => { release(); }); await waitForId('native-auth-reset-invalid');
    expect(NativeAuthBearerPreviewRequestV1Schema.parse(homes.requestsFor(RESET_PREVIEW).at(-1)?.input).token).toBe(NEW);
    expect(homes.requestsFor(RESET_SUBMIT)).toHaveLength(0);
});
it('clears password material when a replacement reset bearer becomes current', async () => {
    await mountReset(OLD); await waitForId('native-auth-reset-password');
    await fill('native-auth-reset-password', PASSWORD); await fill('native-auth-reset-confirm', PASSWORD);
    await screen!.update(root(<NativeAuthPasswordResetScreen token={NEW} homeTarget={SAVED_HOME_IDENTITY} />)); await waitForId('native-auth-reset-password');
    expect(screen!.findByTestId('native-auth-reset-password')?.props.value).toBe(''); expect(screen!.findByTestId('native-auth-reset-confirm')?.props.value).toBe('');
});
it('ignores a completed reset mutation after its bearer has been replaced', async () => {
    let release!: () => void;
    homes.answer(savedHomeProfileId, RESET_SUBMIT, { body: PlainPasswordResetSubmitResponseV1Schema.parse({ v: 1, status: 'password_reset' }), respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    await mountReset(OLD); await submitReset(false);
    await screen!.update(root(<NativeAuthPasswordResetScreen token={NEW} homeTarget={SAVED_HOME_IDENTITY} />)); await waitForId('native-auth-reset-password');
    await act(async () => { release(); }); expect(screen!.findByTestId('native-auth-reset-done')).toBeNull();
    expect(screen!.findByTestId('native-auth-reset-password')).not.toBeNull(); expect(homes.requestsFor(RESET_SUBMIT)).toHaveLength(1);
});
it('shows a specific update-required landing when the exact Home lacks the public reset operation', async () => {
    homes.answer(savedHomeProfileId, RESET_PREVIEW, { status: 404, body: { error: 'not_found' } });
    await mountReset(); await waitForId('native-auth-reset-invalid');
    expect(screen!.getTextContent()).toContain(t('welcome.serverIncompatibleBody', { serverUrl: 'Saved Home' }));
    expect(homes.requestsFor(RESET_SUBMIT)).toHaveLength(0);
});
it('signs in to the exact carried Home after a successful reset instead of falling back to the focused Home', async () => {
    await mountReset(); await openResetLogin(); await submitLogin();
    expect(PlainPasswordResetSubmitRequestV1Schema.parse(homes.requestsFor(RESET_SUBMIT)[0]?.input)).toEqual({ v: 1, token: RESET, password: PASSWORD });
    expect(homes.requestsFor(LOGIN)[0]?.serverId).toBe(savedHomeProfileId);
    expect(await TokenStorage.getCredentialsForServerUrl(SAVED_HOME_URL, { serverId: savedHomeProfileId })).toEqual({ token });
});
function freshHomeBoundary(identity: string) {
    const features = createRootLayoutFeaturesResponse();
    Object.assign(features.capabilities, { serverIdentity: { serverIdentityId: identity } });
    const calls: Array<{ path: string; input: unknown }> = [];
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== FRESH_HOME_URL) return homes.request(input, init);
        calls.push({ path: url.pathname, input: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
        if (url.pathname === '/v1/features') return Response.json(features);
        if (url.pathname === PREVIEW) return Response.json(NativeEmailVerifyPreviewResponseV1Schema.parse({ v: 1, valid: true, maskedDestination: MASKED_EMAIL, continuation: 'account_admission' }));
        return new Response('{}', { status: 404 });
    });
    return calls;
}
it('acquires the exact Home a fresh-device link names, then previews the bearer against it', async () => {
    const calls = freshHomeBoundary(FRESH_HOME_IDENTITY);
    expect(listServerProfiles().some(profile => profile.serverIdentityId === FRESH_HOME_IDENTITY)).toBe(false);
    await mountVerify({ home: currentLinkCarrier(FRESH_HOME_IDENTITY, FRESH_HOME_URL) });
    await waitForHomeGovernance(() => expect(calls.filter(call => call.path === PREVIEW)).toHaveLength(1));
    expect(listServerProfiles().some(profile => profile.serverIdentityId === FRESH_HOME_IDENTITY)).toBe(true);
    expect(NativeAuthBearerPreviewRequestV1Schema.parse(calls.find(call => call.path === PREVIEW)?.input).token).toBe(VERIFY);
    expect(screen!.findByTestId('native-auth-verify-invalid')).toBeNull();
});
it('never presents the bearer to endpoints that answer as a different Home', async () => {
    const calls = freshHomeBoundary('srv_impostor_home');
    await mountVerify({ home: currentLinkCarrier(FRESH_HOME_IDENTITY, FRESH_HOME_URL) }); await waitForId('native-auth-verify-invalid');
    expect(calls.filter(call => call.path === PREVIEW)).toHaveLength(0);
    expect(listServerProfiles().some(profile => profile.serverIdentityId === FRESH_HOME_IDENTITY)).toBe(false);
    expect(screen!.findByTestId('native-auth-verify-retry-home')).not.toBeNull();
});
it('focuses the exact Home a reset signed in to before showing its content', async () => {
    await mountReset(); await openResetLogin(); await submitLogin();
    expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeIdForIdentifier(savedHomeProfileId)); expect(router.replace).toHaveBeenCalledWith('/');
});
it('stays on the reset landing with a retry when the exact Home cannot be focused', async () => {
    await mountReset(); await openResetLogin(); blockFocus = true; await submitLogin();
    expect(router.replace).not.toHaveBeenCalled(); await waitForId('native-auth-reset-destination-home-error');
    blockFocus = false; await screen!.pressByTestIdAsync('native-auth-reset-destination-home-retry');
    await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(router.replace).toHaveBeenCalledWith('/'); expect(homes.requestsFor(LOGIN)).toHaveLength(1);
});
it('focuses the exact Home a native Account was created on before showing its content', async () => {
    await mountVerify(); await openProvision(); await createAccount();
    expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeIdForIdentifier(savedHomeProfileId)); expect(router.replace).toHaveBeenCalledWith('/');
});
it('waits for the exact Home before opening a Team the same admission atomically joined', async () => {
    await mountVerify(); await openProvision(); blockFocus = true; await createAccount('team-a');
    expect(router.replace).not.toHaveBeenCalled(); await waitForId('native-auth-verify-destination-home-error');
    expect(screen!.findByTestId('email-password-create')).toBeNull();
    blockFocus = false; await screen!.pressByTestIdAsync('native-auth-verify-destination-home-retry');
    await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith(`/settings/teams/${SAVED_HOME_IDENTITY}/team-a`));
    expect(router.replace).toHaveBeenCalledWith(`/settings/teams/${SAVED_HOME_IDENTITY}/team-a`);
    expect(router.replace).toHaveBeenCalledOnce(); expect(homes.requestsFor(PROVISION)).toHaveLength(1);
});
it('consumes an email-change confirmation once even when the recipient taps again while it is in flight', async () => {
    await bound(); preview('sign_in_email_change'); let release!: () => void;
    homes.answer(savedHomeProfileId, EMAIL_CHANGE, { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'updated' }), respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    await mountVerify(); await waitForId('native-auth-verify-confirm-change');
    await act(async () => { screen!.pressByTestId('native-auth-verify-confirm-change'); });
    expect(screen!.findByTestId('native-auth-verify-confirm-change-icon')).toBeNull();
    await act(async () => { screen!.pressByTestId('native-auth-verify-confirm-change'); });
    expect(homes.requestsFor(EMAIL_CHANGE)).toHaveLength(1);
    await act(async () => { release(); }); await waitForHomeGovernance(() => expectSecurity());
});
it('keeps a committed email change on a retryable activation state instead of offering the mutation again', async () => {
    await bound(); preview('sign_in_email_change'); await mountVerify(); await waitForId('native-auth-verify-confirm-change');
    blockFocus = true; await act(async () => { screen!.pressByTestId('native-auth-verify-confirm-change'); });
    await waitForId('native-auth-verify-destination-home-error');
    expect(homes.requestsFor(EMAIL_CHANGE)).toHaveLength(1); expect(screen!.findByTestId('native-auth-verify-confirm-change')).toBeNull();
    blockFocus = false;
    await screen!.pressByTestIdAsync('native-auth-verify-destination-home-retry'); await waitForHomeGovernance(() => expectSecurity()); expect(homes.requestsFor(EMAIL_CHANGE)).toHaveLength(1);
});
it('keeps a verified password-enrollment continuation retryable when its Home cannot be activated', async () => {
    await bound(); preview('password_enrollment'); await mountVerify(); await waitForId('native-auth-verify-password-enrollment');
    blockFocus = true; await act(async () => { screen!.pressByTestId('native-auth-verify-password-enrollment'); }); await waitForId('native-auth-verify-destination-home-error');
    blockFocus = false; await screen!.pressByTestIdAsync('native-auth-verify-destination-home-retry'); await waitForHomeGovernance(() => expectSecurity(VERIFY));
    expect(homes.requestsFor(EMAIL_CHANGE)).toHaveLength(0);
});
it('shows the reset submission as working until the Home answers', async () => {
    let release!: () => void;
    homes.answer(savedHomeProfileId, RESET_SUBMIT, { body: PlainPasswordResetSubmitResponseV1Schema.parse({ v: 1, status: 'password_reset' }), respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    await mountReset(); await submitReset(false); expect(screen!.findByTestId('native-auth-reset-submit-icon')).toBeNull(); expect(homes.requestsFor(RESET_SUBMIT)).toHaveLength(1);
    await act(async () => { release(); }); await waitForId('native-auth-reset-done');
});
it('retries the verification preview in place once the exact Home is already acquired', async () => {
    let fail = true;
    homes.answer(savedHomeProfileId, PREVIEW, { select: () => {
        if (fail) { fail = false; return { status: 503, body: { error: 'upstream_error' } }; }
        return { body: NativeEmailVerifyPreviewResponseV1Schema.parse({ v: 1, valid: true, maskedDestination: MASKED_EMAIL, continuation: 'account_admission' }) };
    } });
    await mountVerify(); await waitForId('native-auth-verify-invalid'); expect(screen!.findByTestId('native-auth-verify-retry-home')).toBeNull();
    await screen!.pressByTestIdAsync('native-auth-verify-retry'); expect(homes.requestsFor(PREVIEW)).toHaveLength(2); await waitForId('native-auth-verify-create-account');
});
it('offers no preview retry when the verification link itself is expired', async () => {
    preview(null, false); await mountVerify(); await waitForId('native-auth-verify-invalid');
    expect(screen!.findByTestId('native-auth-verify-retry')).toBeNull(); expect(screen!.findByTestId('native-auth-verify-retry-home')).toBeNull(); expect(homes.requestsFor(PREVIEW)).toHaveLength(1);
});
