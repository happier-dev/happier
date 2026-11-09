import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    listServerProfiles,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { NativeAuthEmailVerifyScreen, NativeAuthPasswordResetScreen } from './NativeAuthLandingScreens';

const boundary = vi.hoisted(() => ({
    preview: vi.fn(),
    resetPreview: vi.fn(),
    fetchAuthEntry: vi.fn(),
    fetchScopedAuthEntry: vi.fn(),
    request: vi.fn(),
    authenticatedRequest: vi.fn(),
    changeEmail: vi.fn(),
    submitReset: vi.fn(),
    readInvitationContinuation: vi.fn(),
    clearInvitationContinuation: vi.fn(),
    replace: vi.fn(),
    openAccountSecurityForHome: vi.fn(),
    refreshFromActiveServer: vi.fn(),
    setActiveServerAndSwitch: vi.fn(),
    scopeKind: 'signed_out' as 'signed_out' | 'bound',
    flowProps: null as Record<string, unknown> | null,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ replace: boundary.replace }) }));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: boundary.refreshFromActiveServer }),
    useOptionalAuth: () => ({ isAuthenticated: false }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: () => boundary.scopeKind === 'bound'
        ? ({ kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } })
        : ({ kind: 'signed_out' }),
}));
vi.mock('@/sync/api/auth/nativeAuthEmail', () => ({
    previewNativeEmailVerification: boundary.preview,
    previewNativePasswordReset: boundary.resetPreview,
    submitNativePasswordReset: boundary.submitReset,
    readNativeEmailVerificationContinuation: boundary.readInvitationContinuation,
    clearNativeEmailVerificationContinuation: boundary.clearInvitationContinuation,
}));
vi.mock('@/sync/api/auth/accountSecurity', () => ({
    changeAccountSignInEmail: boundary.changeEmail,
}));
// The portable Home link owner, the profile/identity owner and the Home
// authentication target resolver all stay real: a landing that routed a bearer
// without a genuinely saved, identity-matched Home has to fail here.
// Focus itself stays real: `focusExactHomeAndRefresh` decides `requireExactProfile`,
// the already-active refresh, and the blocked/failed outcome. Only the connection
// switch underneath it — a genuine runtime boundary — is replaced.
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: boundary.setActiveServerAndSwitch,
}));
vi.mock('@/components/settings/account/openAccountSecurityForHome', () => ({
    openAccountSecurityForHome: boundary.openAccountSecurityForHome,
}));
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    createServerFetchAtEndpoint: (params: { credentials?: unknown }) => (
        params.credentials === null ? boundary.request : boundary.authenticatedRequest
    ),
}));
vi.mock('@/auth/entry/authEntryClient', () => ({
    fetchHomeAuthEntry: boundary.fetchAuthEntry,
    fetchAuthEntry: boundary.fetchScopedAuthEntry,
}));
vi.mock('@/components/account/auth/HomeAuthenticationFlow', () => ({
    HomeAuthenticationFlow: (props: Record<string, unknown>) => {
        boundary.flowProps = props;
        const testID = props.nativeAdmission
            ? 'native-auth-admission-flow'
            : props.returnTo === '/'
                ? 'native-auth-reset-sign-in-flow'
                : 'native-auth-email-change-flow';
        return React.createElement('HomeAuthenticationFlow', { testID });
    },
}));

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
/** The device-local profile id of the saved Home; it is not the portable identity. */
let savedHomeProfileId = '';

const SAVED_HOME_URL = 'https://saved.example.test';
const SAVED_HOME_IDENTITY = 'srv_saved_home';
const FRESH_HOME_URL = 'https://fresh.example.test';
const FRESH_HOME_IDENTITY = 'srv_fresh_home';

/** A current link: the Home's own strict descriptor, as the mail producer emits it. */
function currentLinkCarrier(params: Readonly<{ identity: string; url: string }>): string {
    return JSON.stringify({
        kind: 'descriptor',
        authority: 'trusted_enrollment',
        descriptor: {
            v: 1,
            homeServerIdentityId: params.identity,
            canonicalServerUrl: params.url,
            revision: 1,
            endpoints: [{ kind: 'https', url: params.url }],
        },
    });
}

/** How the unverified endpoints answer the public feature probe. */
function answerFeatureProbeAs(serverIdentityId: string | null): void {
    const features = createRootLayoutFeaturesResponse();
    (features.capabilities as { serverIdentity: { serverIdentityId: string | null } })
        .serverIdentity = { serverIdentityId };
    boundary.request.mockImplementation(async () => new Response(JSON.stringify(features), {
        headers: { 'content-type': 'application/json' },
    }));
}

beforeEach(async () => {
    boundary.scopeKind = 'signed_out';
    boundary.flowProps = null;
    boundary.preview.mockReset();
    boundary.resetPreview.mockReset();
    boundary.fetchAuthEntry.mockReset();
    boundary.fetchScopedAuthEntry.mockReset();
    boundary.request.mockReset();
    boundary.changeEmail.mockReset();
    boundary.submitReset.mockReset();
    boundary.readInvitationContinuation.mockReset();
    boundary.clearInvitationContinuation.mockReset();
    boundary.openAccountSecurityForHome.mockReset();
    boundary.openAccountSecurityForHome.mockResolvedValue(true);
    boundary.refreshFromActiveServer.mockReset();
    boundary.refreshFromActiveServer.mockResolvedValue(undefined);
    boundary.setActiveServerAndSwitch.mockReset();
    boundary.setActiveServerAndSwitch.mockResolvedValue('switched');
    boundary.replace.mockReset();
    boundary.changeEmail.mockResolvedValue(undefined);
    boundary.submitReset.mockResolvedValue(undefined);
    boundary.readInvitationContinuation.mockReturnValue(null);
    resetServerFeaturesClientForTests();
    savedHomeProfileId = (await upsertServerProfile({ serverUrl: SAVED_HOME_URL, name: 'Saved Home' })).id;
    await setServerProfileIdentityForUrl(SAVED_HOME_URL, SAVED_HOME_IDENTITY);
    answerFeatureProbeAs(FRESH_HOME_IDENTITY);
    boundary.fetchAuthEntry.mockResolvedValue({
        kind: 'ready',
        projection: {
            v: 1,
            scope: { kind: 'home' },
            state: 'ready',
            signInService: undefined,
            autoRedirect: null,
            actions: [
                {
                    kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either', origin: 'home',
                    presentation: { displayName: 'Email and password' },
                },
                {
                    kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'either', origin: 'home',
                    presentation: { displayName: 'Email and password' },
                },
            ],
        },
    });
    boundary.fetchScopedAuthEntry.mockResolvedValue({
        kind: 'ready',
        projection: {
            v: 1,
            scope: { kind: 'invitation' },
            state: 'admission_required',
            team: { teamId: 'team-a', name: 'Team A', logo: null },
            autoRedirect: null,
            actions: [{
                kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'either', origin: 'team',
                presentation: { displayName: 'Email and password' },
            }],
        },
    });
    boundary.preview.mockResolvedValue({
        v: 1,
        valid: true,
        maskedDestination: 'p***@example.test',
        continuation: 'account_admission',
    });
    boundary.resetPreview.mockResolvedValue({ v: 1, valid: true });
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    await standardCleanup();
    resetServerFeaturesClientForTests();
});

it('continues a verified mailbox proof into the exact Home provision controller without losing its bearer', async () => {
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await screen.pressByTestIdAsync('native-auth-verify-create-account');

    expect(screen.findByTestId('native-auth-admission-flow')).not.toBeNull();
    expect(boundary.flowProps).toMatchObject({
        target: { kind: 'saved_profile', profileRef: savedHomeProfileId },
        nativeAdmission: { kind: 'native_email_verification', token: 'verification-bearer' },
    });
    expect(boundary.preview).toHaveBeenCalledWith(boundary.request, 'verification-bearer');
});

it('retries authentication discovery after a valid verification preview without replaying the preview', async () => {
    boundary.fetchScopedAuthEntry.mockRejectedValueOnce(new TypeError('offline'));
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-retry-auth')).not.toBeNull());

    await screen.pressByTestIdAsync('native-auth-verify-retry-auth');
    await screen.pressByTestIdAsync('native-auth-verify-create-account');

    expect(screen.findByTestId('native-auth-admission-flow')).not.toBeNull();
    expect(boundary.flowProps).toMatchObject({
        target: { kind: 'saved_profile', profileRef: savedHomeProfileId },
        nativeAdmission: { kind: 'native_email_verification', token: 'verification-bearer' },
    });
    expect(boundary.preview).toHaveBeenCalledTimes(1);
});

it('opens a mailed link as a step of the welcome split, not a bare page', async () => {
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    expect(screen.findByTestId('unauth-shell-native-auth-reset')).not.toBeNull();
    expect(screen.findByTestId('native-auth-reset-title')).not.toBeNull();
});

it('recovers sign-in discovery after a completed reset without resetting the password again', async () => {
    boundary.fetchAuthEntry.mockRejectedValueOnce(new TypeError('offline'));
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await act(async () => {
        screen?.changeTextByTestId('native-auth-reset-password', 'a valid new password');
        screen?.changeTextByTestId('native-auth-reset-confirm', 'a valid new password');
    });
    await screen.pressByTestIdAsync('native-auth-reset-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-done')).not.toBeNull());

    await screen.pressByTestIdAsync('native-auth-reset-retry-auth');
    await screen.pressByTestIdAsync('native-auth-reset-sign-in');

    expect(screen.findByTestId('native-auth-reset-sign-in-flow')).not.toBeNull();
    expect(boundary.flowProps).toMatchObject({ target: { kind: 'saved_profile', profileRef: savedHomeProfileId } });
    expect(boundary.submitReset).toHaveBeenCalledTimes(1);
    expect(boundary.resetPreview).toHaveBeenCalledTimes(1);
});

it('resumes transferable invitation provision with the unchanged admission and exact mailbox bearer', async () => {
    const admission = { kind: 'team_invitation' as const, token: 'I'.repeat(43) };
    boundary.readInvitationContinuation.mockReturnValue({
        homeServerIdentityId: SAVED_HOME_IDENTITY,
        normalizedEmail: 'person@example.test',
        admission,
    });
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await screen.pressByTestIdAsync('native-auth-verify-create-account');

    expect(boundary.flowProps).toMatchObject({
        nativeAdmission: { ...admission, emailVerificationToken: 'verification-bearer' },
    });
    expect(boundary.readInvitationContinuation).toHaveBeenCalledWith({
        homeServerIdentityId: SAVED_HOME_IDENTITY,
        maskedDestination: 'p***@example.test',
    });

    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'created' },
        });
    });
    expect(boundary.clearInvitationContinuation).toHaveBeenCalledWith({
        homeServerIdentityId: SAVED_HOME_IDENTITY,
        normalizedEmail: 'person@example.test',
        admission,
    });
});

it('brings the mailbox it just verified back to self-service Account creation', async () => {
    // Same running client, no invitation: the landing proved this address, so the panel
    // must not ask for it again.
    boundary.readInvitationContinuation.mockReturnValue({
        homeServerIdentityId: SAVED_HOME_IDENTITY,
        normalizedEmail: 'person@example.test',
    });
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await screen.pressByTestIdAsync('native-auth-verify-create-account');

    expect(boundary.flowProps).toMatchObject({
        nativeAdmission: { kind: 'native_email_verification', token: 'verification-bearer' },
        initialEmail: 'person@example.test',
    });
});

it('uses invitation-scoped admission actions when the ordinary Home is invitation-only', async () => {
    const admission = { kind: 'team_invitation' as const, token: 'I'.repeat(43) };
    boundary.readInvitationContinuation.mockReturnValue({
        homeServerIdentityId: SAVED_HOME_IDENTITY,
        normalizedEmail: 'person@example.test',
        admission,
    });
    boundary.fetchAuthEntry.mockResolvedValueOnce({
        kind: 'ready',
        projection: {
            v: 1,
            scope: { kind: 'home' },
            state: 'ready',
            autoRedirect: null,
            actions: [],
        },
    });

    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-create-account')).not.toBeNull());

    expect(boundary.fetchScopedAuthEntry).toHaveBeenCalledWith(expect.objectContaining({
        scope: { kind: 'invitation', token: admission.token },
        endpointUrl: SAVED_HOME_URL,
        serverId: savedHomeProfileId,
    }));
    await screen.pressByTestIdAsync('native-auth-verify-create-account');
    expect(boundary.flowProps).toMatchObject({
        actions: [expect.objectContaining({ action: expect.objectContaining({ id: 'provision' }) })],
        nativeAdmission: { ...admission, emailVerificationToken: 'verification-bearer' },
    });
});

it('uses the verification-scoped entry after a fresh-document invitation link and routes its Team result', async () => {
    boundary.readInvitationContinuation.mockReturnValue(null);
    boundary.fetchAuthEntry.mockResolvedValueOnce({
        kind: 'ready',
        projection: {
            v: 1,
            scope: { kind: 'home' },
            state: 'ready',
            autoRedirect: null,
            actions: [],
        },
    });

    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-create-account')).not.toBeNull());

    expect(boundary.fetchScopedAuthEntry).toHaveBeenCalledWith(expect.objectContaining({
        scope: { kind: 'native_email_verification', token: 'verification-bearer' },
        endpointUrl: SAVED_HOME_URL,
        serverId: savedHomeProfileId,
    }));
    expect(boundary.fetchAuthEntry).not.toHaveBeenCalled();

    await screen.pressByTestIdAsync('native-auth-verify-create-account');
    expect(boundary.flowProps).toMatchObject({
        nativeAdmission: { kind: 'native_email_verification', token: 'verification-bearer' },
    });
    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'created' },
            teamId: 'team-a',
        });
    });
    expect(boundary.replace).toHaveBeenCalledWith(`/settings/teams/${SAVED_HOME_IDENTITY}/team-a`);
});

it('signs in to the carried Home before continuing password enrollment with the same bearer', async () => {
    boundary.preview.mockResolvedValueOnce({
        v: 1,
        valid: true,
        maskedDestination: 'p***@example.test',
        continuation: 'password_enrollment',
    });
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="enrollment-bearer" homeTarget={SAVED_HOME_IDENTITY} />);

    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-sign-in')).not.toBeNull());
    await screen.pressByTestIdAsync('native-auth-verify-sign-in');
    expect(boundary.flowProps).toMatchObject({
        target: { kind: 'saved_profile', profileRef: savedHomeProfileId },
        returnTo: '/auth/email/verify/enrollment-bearer?target=' + SAVED_HOME_IDENTITY,
    });

    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'fresh-home-a-token' },
        });
    });
    expect(boundary.changeEmail).not.toHaveBeenCalled();
    expect(boundary.openAccountSecurityForHome).toHaveBeenCalledWith({
        serverId: savedHomeProfileId,
        router: { replace: boundary.replace },
        refreshAuth: boundary.refreshFromActiveServer,
        verificationToken: 'enrollment-bearer',
    });
});

it('fails closed without a portable Home target and never previews the bearer against the focused Home', async () => {
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={null} />);

    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-invalid')).not.toBeNull());
    expect(boundary.preview).not.toHaveBeenCalled();
});

it('fails a password-reset landing closed when the Home profile cannot be resolved', async () => {
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={null} />);

    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-invalid')).not.toBeNull());
    expect(boundary.resetPreview).not.toHaveBeenCalled();
});

it('authenticates a signed-out email-change recipient against the carried Home and consumes the bearer only in the owning mutation', async () => {
    boundary.preview.mockResolvedValueOnce({
        v: 1,
        valid: true,
        maskedDestination: 'n***@example.test',
        continuation: 'sign_in_email_change',
    });
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="email-change-bearer" homeTarget={SAVED_HOME_IDENTITY} />);

    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-sign-in')).not.toBeNull());
    expect(boundary.changeEmail).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('native-auth-verify-sign-in');

    expect(screen.findByTestId('native-auth-email-change-flow')).not.toBeNull();
    expect(boundary.flowProps).toMatchObject({
        target: { kind: 'saved_profile', profileRef: savedHomeProfileId },
        returnTo: '/auth/email/verify/email-change-bearer?target=' + SAVED_HOME_IDENTITY,
    });
    expect(boundary.flowProps?.actions).toEqual([
        expect.objectContaining({ action: expect.objectContaining({ id: 'login' }) }),
    ]);

    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'fresh-home-a-token' },
        });
    });

    expect(boundary.changeEmail).toHaveBeenCalledWith(
        boundary.authenticatedRequest,
        { verificationToken: 'email-change-bearer' },
    );
    expect(boundary.openAccountSecurityForHome).toHaveBeenCalledWith({
        serverId: savedHomeProfileId,
        router: { replace: boundary.replace },
        refreshAuth: boundary.refreshFromActiveServer,
    });
});

it('makes a previous verification preview inert while a replacement bearer is being checked', async () => {
    boundary.preview.mockResolvedValueOnce({
        v: 1,
        valid: true,
        maskedDestination: 'n***@example.test',
        continuation: 'sign_in_email_change',
    });
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="old-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-sign-in')).not.toBeNull());

    let finishReplacementPreview!: (value: unknown) => void;
    boundary.preview.mockReturnValueOnce(new Promise((resolve) => { finishReplacementPreview = resolve; }));
    await screen.update(<NativeAuthEmailVerifyScreen token="new-bearer" homeTarget={SAVED_HOME_IDENTITY} />);

    expect(screen.findByTestId('native-auth-verify-sign-in')).toBeNull();
    expect(boundary.preview).toHaveBeenLastCalledWith(boundary.request, 'new-bearer');

    await act(async () => {
        finishReplacementPreview({ v: 1, valid: false, maskedDestination: null, continuation: null });
    });
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-invalid')).not.toBeNull());
    expect(boundary.changeEmail).not.toHaveBeenCalled();
});

it('makes the old reset form inert while a replacement bearer is being checked', async () => {
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="old-reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    expect(boundary.resetPreview).toHaveBeenCalledWith(boundary.request, 'old-reset-bearer');

    let finishReplacementPreview!: (value: unknown) => void;
    boundary.resetPreview.mockReturnValueOnce(new Promise((resolve) => { finishReplacementPreview = resolve; }));
    await screen.update(<NativeAuthPasswordResetScreen token="new-reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);

    expect(screen.findByTestId('native-auth-reset-password')).toBeNull();
    expect(boundary.resetPreview).toHaveBeenLastCalledWith(boundary.request, 'new-reset-bearer');

    await act(async () => {
        finishReplacementPreview({ v: 1, valid: false });
    });
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-invalid')).not.toBeNull());
    expect(boundary.submitReset).not.toHaveBeenCalled();
});


it('clears password material when a replacement reset bearer becomes current', async () => {
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="old-reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('native-auth-reset-password', 'old bearer password');
        screen?.changeTextByTestId('native-auth-reset-confirm', 'old bearer password');
    });

    boundary.resetPreview.mockResolvedValueOnce({ v: 1, valid: true });
    await screen.update(<NativeAuthPasswordResetScreen token="new-reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());

    expect(screen.findByTestId('native-auth-reset-password')?.props.value).toBe('');
    expect(screen.findByTestId('native-auth-reset-confirm')?.props.value).toBe('');
});

it('ignores a completed reset mutation after its bearer has been replaced', async () => {
    let finishOldReset!: () => void;
    boundary.submitReset.mockReturnValueOnce(new Promise<void>((resolve) => { finishOldReset = resolve; }));
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="old-reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('native-auth-reset-password', 'old bearer password');
        screen?.changeTextByTestId('native-auth-reset-confirm', 'old bearer password');
    });
    await act(async () => { screen?.pressByTestId('native-auth-reset-submit'); });

    boundary.resetPreview.mockResolvedValueOnce({ v: 1, valid: true });
    await screen.update(<NativeAuthPasswordResetScreen token="new-reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    await act(async () => { finishOldReset(); });

    expect(screen.findByTestId('native-auth-reset-done')).toBeNull();
    expect(screen.findByTestId('native-auth-reset-password')).not.toBeNull();
    expect(boundary.submitReset).toHaveBeenCalledTimes(1);
});

it('shows a specific update-required landing when the exact Home lacks the public reset operation', async () => {
    boundary.resetPreview.mockRejectedValueOnce(new HappyError('unsupported', false, {
        status: 404,
        code: 'client_update_required',
    }));

    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-invalid')).not.toBeNull());

    expect(screen.findByTestId('native-auth-reset-invalid')?.props.children).toBe(
        t('welcome.serverIncompatibleBody', { serverUrl: 'Saved Home' }),
    );
    expect(boundary.submitReset).not.toHaveBeenCalled();
});

it('signs in to the exact carried Home after a successful reset instead of falling back to the focused Home', async () => {
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('native-auth-reset-password', 'correct horse battery staple');
        screen?.changeTextByTestId('native-auth-reset-confirm', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('native-auth-reset-submit');

    expect(boundary.submitReset).toHaveBeenCalledWith(boundary.request, {
        token: 'reset-bearer',
        password: 'correct horse battery staple',
    });
    await screen.pressByTestIdAsync('native-auth-reset-sign-in');

    expect(screen.findByTestId('native-auth-reset-sign-in-flow')).not.toBeNull();
    expect(boundary.flowProps).toMatchObject({
        target: { kind: 'saved_profile', profileRef: savedHomeProfileId },
        returnTo: '/',
    });
    expect(boundary.flowProps?.actions).toEqual([
        expect.objectContaining({ action: expect.objectContaining({ id: 'login' }) }),
    ]);
});

it('acquires the exact Home a fresh-device link names, then previews the bearer against it', async () => {
    answerFeatureProbeAs(FRESH_HOME_IDENTITY);
    const carrier = currentLinkCarrier({ identity: FRESH_HOME_IDENTITY, url: FRESH_HOME_URL });

    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={carrier} />);

    // A fresh device has nothing saved for this Home. The link carries the
    // Home's own descriptor, so the landing stays on the link and acquires it
    // rather than dead-ending on an identity it cannot reach.
    await vi.waitFor(() => expect(boundary.preview).toHaveBeenCalledTimes(1));
    const acquired = listServerProfiles().find((profile) => profile.serverIdentityId === FRESH_HOME_IDENTITY);
    expect(acquired).toBeDefined();
    expect(boundary.preview).toHaveBeenCalledWith(boundary.request, 'verification-bearer');
    expect(screen.findByTestId('native-auth-verify-invalid')).toBeNull();
});

it('never presents the bearer to endpoints that answer as a different Home', async () => {
    answerFeatureProbeAs('srv_impostor_home');
    const carrier = currentLinkCarrier({ identity: FRESH_HOME_IDENTITY, url: FRESH_HOME_URL });

    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={carrier} />);

    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-invalid')).not.toBeNull());
    expect(boundary.preview).not.toHaveBeenCalled();
    expect(listServerProfiles().some((profile) => profile.serverIdentityId === FRESH_HOME_IDENTITY)).toBe(false);
    // A Home that cannot be verified now may simply be unreachable now.
    expect(screen.findByTestId('native-auth-verify-retry-home')).not.toBeNull();
});

it('focuses the exact Home a reset signed in to before showing its content', async () => {
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('native-auth-reset-password', 'correct horse battery staple');
        screen?.changeTextByTestId('native-auth-reset-confirm', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('native-auth-reset-submit');
    await screen.pressByTestIdAsync('native-auth-reset-sign-in');

    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'reset-home-token' },
        });
    });

    // Home A may still be focused. Replacing the route without moving focus
    // would show Home A's content and read as the reset having done nothing.
    expect(boundary.setActiveServerAndSwitch).toHaveBeenCalledWith({
        serverId: savedHomeProfileId,
        scope: 'device',
        refreshAuth: boundary.refreshFromActiveServer,
        requireExactProfile: true,
    });
    expect(boundary.replace).toHaveBeenCalledWith('/');
});

it('stays on the reset landing with a retry when the exact Home cannot be focused', async () => {
    boundary.setActiveServerAndSwitch.mockResolvedValue('blocked');
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('native-auth-reset-password', 'correct horse battery staple');
        screen?.changeTextByTestId('native-auth-reset-confirm', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('native-auth-reset-submit');
    await screen.pressByTestIdAsync('native-auth-reset-sign-in');

    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'reset-home-token' },
        });
    });

    expect(boundary.replace).not.toHaveBeenCalled();
    expect(screen.findByTestId('native-auth-reset-destination-home-error')).not.toBeNull();

    boundary.setActiveServerAndSwitch.mockResolvedValue('switched');
    await screen.pressByTestIdAsync('native-auth-reset-destination-home-retry');
    expect(boundary.replace).toHaveBeenCalledWith('/');
});

it('focuses the exact Home a native Account was created on before showing its content', async () => {
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await screen.pressByTestIdAsync('native-auth-verify-create-account');

    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'created' },
        });
    });

    expect(boundary.setActiveServerAndSwitch).toHaveBeenCalledWith({
        serverId: savedHomeProfileId,
        scope: 'device',
        refreshAuth: boundary.refreshFromActiveServer,
        requireExactProfile: true,
    });
    expect(boundary.replace).toHaveBeenCalledWith('/');
});

it('waits for the exact Home before opening a Team the same admission atomically joined', async () => {
    // Atomic Team admission is still an Account created on the Home the link
    // named. Opening the Team route first would render the previously focused
    // Home's Teams stack and read as the join having silently failed.
    boundary.setActiveServerAndSwitch.mockResolvedValue('blocked');
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await screen.pressByTestIdAsync('native-auth-verify-create-account');

    await act(async () => {
        await (boundary.flowProps?.onAuthenticated as (value: unknown) => Promise<void>)({
            homeServerIdentityId: SAVED_HOME_IDENTITY,
            credentials: { token: 'created' },
            teamId: 'team-a',
        });
    });

    expect(boundary.replace).not.toHaveBeenCalled();
    expect(screen.findByTestId('native-auth-verify-destination-home-error')).not.toBeNull();
    // The admission affordance is retired, so nothing here can create a second
    // Account or resubmit the verification bearer.
    expect(screen.findByTestId('native-auth-admission-flow')).toBeNull();

    boundary.setActiveServerAndSwitch.mockResolvedValue('switched');
    await screen.pressByTestIdAsync('native-auth-verify-destination-home-retry');

    expect(boundary.replace).toHaveBeenCalledWith(`/settings/teams/${SAVED_HOME_IDENTITY}/team-a`);
    expect(boundary.replace).toHaveBeenCalledOnce();
    // Retry re-ran the focus and nothing else.
    expect(boundary.setActiveServerAndSwitch).toHaveBeenCalledTimes(2);
});

it('consumes an email-change confirmation once even when the recipient taps again while it is in flight', async () => {
    boundary.scopeKind = 'bound';
    boundary.preview.mockResolvedValueOnce({
        v: 1,
        valid: true,
        maskedDestination: 'n***@example.test',
        continuation: 'sign_in_email_change',
    });
    let finishChange!: () => void;
    boundary.changeEmail.mockReturnValueOnce(new Promise<void>((resolve) => { finishChange = resolve; }));
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="email-change-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-confirm-change')).not.toBeNull());

    await act(async () => { screen?.pressByTestId('native-auth-verify-confirm-change'); });
    // The card must read as working rather than untouched while the Home answers.
    expect(screen.findByTestId('native-auth-verify-confirm-change-icon')).toBeNull();

    await act(async () => { screen?.pressByTestId('native-auth-verify-confirm-change'); });
    // The one-time bearer must never be submitted twice.
    expect(boundary.changeEmail).toHaveBeenCalledTimes(1);

    await act(async () => { finishChange(); });
    await vi.waitFor(() => expect(boundary.openAccountSecurityForHome).toHaveBeenCalledTimes(1));
});

it('keeps a committed email change on a retryable activation state instead of offering the mutation again', async () => {
    boundary.scopeKind = 'bound';
    boundary.preview.mockResolvedValueOnce({
        v: 1,
        valid: true,
        maskedDestination: 'n***@example.test',
        continuation: 'sign_in_email_change',
    });
    boundary.openAccountSecurityForHome.mockResolvedValueOnce(false);
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="email-change-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-confirm-change')).not.toBeNull());

    await screen.pressByTestIdAsync('native-auth-verify-confirm-change');

    // The address already changed on the exact Home; only reaching it failed.
    // Leaving the Confirm affordance mounted would invite a second submission of
    // a one-time bearer that has already been consumed.
    expect(boundary.changeEmail).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('native-auth-verify-confirm-change')).toBeNull();
    expect(screen.findByTestId('native-auth-verify-destination-home-error')).not.toBeNull();

    await screen.pressByTestIdAsync('native-auth-verify-destination-home-retry');

    // Retry re-runs activation alone.
    expect(boundary.openAccountSecurityForHome).toHaveBeenCalledTimes(2);
    expect(boundary.changeEmail).toHaveBeenCalledTimes(1);
});

it('keeps a verified password-enrollment continuation retryable when its Home cannot be activated', async () => {
    boundary.scopeKind = 'bound';
    boundary.preview.mockResolvedValueOnce({
        v: 1,
        valid: true,
        maskedDestination: 'n***@example.test',
        continuation: 'password_enrollment',
    });
    boundary.openAccountSecurityForHome.mockResolvedValueOnce(false);
    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="enrollment-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-password-enrollment')).not.toBeNull());

    await screen.pressByTestIdAsync('native-auth-verify-password-enrollment');

    expect(screen.findByTestId('native-auth-verify-destination-home-error')).not.toBeNull();

    await screen.pressByTestIdAsync('native-auth-verify-destination-home-retry');

    // The bearer travels to Account Security unchanged, first time and on retry; retry never re-mints it.
    const activation = {
        serverId: savedHomeProfileId,
        router: { replace: boundary.replace },
        refreshAuth: boundary.refreshFromActiveServer,
        verificationToken: 'enrollment-bearer',
    };
    expect(boundary.openAccountSecurityForHome.mock.calls).toEqual([[activation], [activation]]);
});

it('shows the reset submission as working until the Home answers', async () => {
    screen = await renderScreen(<NativeAuthPasswordResetScreen token="reset-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-password')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('native-auth-reset-password', 'correct horse battery staple');
        screen?.changeTextByTestId('native-auth-reset-confirm', 'correct horse battery staple');
    });

    let finishReset!: () => void;
    boundary.submitReset.mockReturnValueOnce(new Promise<void>((resolve) => { finishReset = resolve; }));
    await act(async () => { screen?.pressByTestId('native-auth-reset-submit'); });

    expect(screen.findByTestId('native-auth-reset-submit-icon')).toBeNull();
    expect(boundary.submitReset).toHaveBeenCalledTimes(1);

    await act(async () => { finishReset(); });
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-reset-done')).not.toBeNull());
});

it('retries the verification preview in place once the exact Home is already acquired', async () => {
    boundary.preview.mockReset();
    boundary.preview.mockRejectedValueOnce(new HappyError('Home unreachable', true, { kind: 'network' }));
    boundary.preview.mockResolvedValue({
        v: 1, valid: true, maskedDestination: 'p***@example.test', continuation: 'account_admission',
    });

    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-invalid')).not.toBeNull());

    // The Home resolved; only the read failed, so the Home-acquisition retry is
    // not the affordance this state needs — the preview owns its own.
    expect(screen.findByTestId('native-auth-verify-retry-home')).toBeNull();
    await screen.pressByTestIdAsync('native-auth-verify-retry');

    expect(boundary.preview).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-create-account')).not.toBeNull());
});

it('offers no preview retry when the verification link itself is expired', async () => {
    boundary.preview.mockReset();
    boundary.preview.mockResolvedValue({ v: 1, valid: false });

    screen = await renderScreen(<NativeAuthEmailVerifyScreen token="verification-bearer" homeTarget={SAVED_HOME_IDENTITY} />);
    await vi.waitFor(() => expect(screen?.findByTestId('native-auth-verify-invalid')).not.toBeNull());

    // An expired or revoked bearer is terminal: re-reading it cannot change it.
    expect(screen.findByTestId('native-auth-verify-retry')).toBeNull();
    expect(screen.findByTestId('native-auth-verify-retry-home')).toBeNull();
    expect(boundary.preview).toHaveBeenCalledTimes(1);
});
