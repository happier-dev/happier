import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { EmailPasswordAuthPanel } from './EmailPasswordAuthPanel';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const passwordLogin = vi.hoisted(() => ({ login: vi.fn() }));
const nativeEmail = vi.hoisted(() => ({
    requestVerification: vi.fn(),
    rememberInvitation: vi.fn(),
    requestReset: vi.fn(),
}));
const provision = vi.hoisted(() => ({ account: vi.fn() }));

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@/auth/password/loginEmailPassword', () => ({ loginEmailPassword: passwordLogin.login }));
vi.mock('@/auth/password/provisionEmailPasswordAccount', () => ({ provisionEmailPasswordAccount: provision.account }));
vi.mock('@/sync/api/auth/nativeAuthEmail', () => ({
    requestNativeEmailVerification: nativeEmail.requestVerification,
    rememberNativeEmailVerificationContinuation: nativeEmail.rememberInvitation,
    requestNativePasswordReset: nativeEmail.requestReset,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const TARGET = {
    endpointUrl: 'https://home-a.example.test',
    canonicalServerUrl: 'https://home-a.example.test',
    addressAnchorUrl: 'https://home-a.example.test',
    serverId: 'home-a',
    serverIdentityId: 'srv_home_a',
} as const;

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    router.push.mockReset();
    passwordLogin.login.mockReset();
    nativeEmail.requestVerification.mockReset();
    nativeEmail.rememberInvitation.mockReset();
    nativeEmail.requestReset.mockReset();
    provision.account.mockReset();
});

async function renderPanel(props: Partial<React.ComponentProps<typeof EmailPasswordAuthPanel>> = {}) {
    return renderScreen(
        <EmailPasswordAuthPanel
            target={TARGET}
            recoveryTarget="srv_home_a"
            action="login"
            mode="either"
            onAuthenticated={vi.fn()}
            {...props}
        />,
    );
}

it('asks only for the address when creation must prove the mailbox first', async () => {
    nativeEmail.requestVerification.mockResolvedValue(undefined);
    screen = await renderPanel({ action: 'provision' });

    // The password typed here would be discarded: the Account is created on the
    // verification landing, so this step must not ask for one.
    expect(screen.findByTestId('email-password-password')).toBeNull();
    expect(screen.findByTestId('email-password-confirm')).toBeNull();
    expect(screen.findByTestId('email-password-protection-e2ee')).toBeNull();

    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText(' Person@Example.test ');
    });
    await screen.pressByTestIdAsync('email-password-create');

    expect(nativeEmail.requestVerification).toHaveBeenCalledWith(expect.any(Function), {
        email: 'person@example.test',
    });
    expect(provision.account).not.toHaveBeenCalled();
});

it('collects the password once the mailbox is already proven and creates the Account with the chosen protection', async () => {
    provision.account.mockResolvedValue({ credentials: { token: 'created' }, accountId: 'account-a' });
    const admission = { kind: 'native_email_verification', token: 'C'.repeat(43) } as const;
    screen = await renderPanel({ action: 'provision', admission, recommendedProvisionMode: 'e2ee' });

    expect(screen.findByTestId('email-password-password')).not.toBeNull();
    expect(screen.findByTestId('email-password-confirm')).not.toBeNull();
    // The Home's recommendation is the starting choice; the person's choice is what is created.
    expect(screen.findByTestId('email-password-protection-e2ee')?.props.accessibilityState).toMatchObject({ checked: true });
    await screen.pressByTestIdAsync('email-password-protection-plain');
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        screen!.findByTestId('email-password-password')!.props.onChangeText('a sufficiently long password');
        screen!.findByTestId('email-password-confirm')!.props.onChangeText('a sufficiently long password');
    });
    await screen.pressByTestIdAsync('email-password-create');

    expect(provision.account).toHaveBeenCalledWith(expect.objectContaining({
        target: TARGET,
        password: 'a sufficiently long password',
        accountMode: 'plain',
        admission,
    }));
});

it('marks its own actions busy while the key derivation runs, in every host', async () => {
    let release = (): void => {};
    passwordLogin.login.mockImplementation(() => new Promise((resolve) => {
        release = () => resolve({ token: 'signed-in' });
    }));
    screen = await renderPanel();
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        screen!.findByTestId('email-password-password')!.props.onChangeText('a sufficiently long password');
    });

    await act(async () => {
        void screen!.findByTestId('email-password-submit')!.props.onPress();
    });

    // The panel owns admission, so the pressed action is busy and the others
    // are closed even when no host wrapped it in a WelcomeActionList.
    expect(screen.findByTestId('email-password-submit-icon')).toBeNull();
    expect(screen.findByTestId('email-password-forgot')?.props.disabled).toBe(true);

    await act(async () => { release(); });
    expect(screen.findByTestId('email-password-forgot')?.props.disabled).toBe(false);
});

it('confirms a resend instead of returning to a pixel-identical screen', async () => {
    nativeEmail.requestVerification.mockResolvedValue(undefined);
    screen = await renderPanel({ action: 'provision' });
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
    });
    await screen.pressByTestIdAsync('email-password-create');
    // An accepted request does not establish delivery, so the confirmation stays neutral.
    expect(screen.findByTestId('email-password-sent-detail')?.props.children).toBe(
        "Look for a link at person@example.test. It can take a minute; check spam if it doesn't arrive.",
    );

    await screen.pressByTestIdAsync('email-password-resend');

    const confirmation = screen.findByTestId('email-password-resent');
    expect(confirmation).not.toBeNull();
    expect(confirmation?.props.accessibilityLiveRegion).toBe('polite');
    expect(confirmation?.props.children).toBe('Check your email again in a minute.');
    expect(nativeEmail.requestVerification).toHaveBeenCalledTimes(2);
});

it('associates the email problem with the field that owns it', async () => {
    screen = await renderPanel({ action: 'provision' });
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('not-an-address');
    });
    await screen.pressByTestIdAsync('email-password-create');

    const error = screen.findByTestId('email-password-email-error');
    expect(error).not.toBeNull();
    expect(screen.findByTestId('email-password-email')?.props['aria-describedby'])
        .toContain(error?.props.nativeID);
});

it('shows the reset request its own field error and submits from the address field', async () => {
    screen = await renderPanel({ action: 'login', passwordReset: 'email' });
    await screen.pressByTestIdAsync('email-password-forgot');

    await screen.pressByTestIdAsync('email-password-request-reset');
    const emptyError = screen.findByTestId('email-password-email-error');
    expect(emptyError).not.toBeNull();
    expect(screen.findByTestId('email-password-email')?.props['aria-describedby'])
        .toContain(emptyError?.props.nativeID);
    expect(nativeEmail.requestReset).not.toHaveBeenCalled();

    // The same address acceptance the rest of this surface uses, not a bare
    // emptiness check: a malformed address is refused before the request.
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('not-an-address');
    });
    await screen.pressByTestIdAsync('email-password-request-reset');
    expect(screen.findByTestId('email-password-email-error')).not.toBeNull();
    expect(nativeEmail.requestReset).not.toHaveBeenCalled();

    // There is no password field in this view, so Return submits the request.
    nativeEmail.requestReset.mockResolvedValue(undefined);
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
    });
    const field = screen.findByTestId('email-password-email');
    expect(field?.props.returnKeyType).toBe('go');
    await act(async () => { field!.props.onSubmitEditing(); });
    expect(nativeEmail.requestReset).toHaveBeenCalledWith(expect.any(Function), 'person@example.test');
});

it('offers the Account protections as an announced selection', async () => {
    screen = await renderPanel({
        action: 'provision',
        admission: { kind: 'native_email_verification', token: 'D'.repeat(43) },
    });

    const plain = screen.findByTestId('email-password-protection-plain');
    const e2ee = screen.findByTestId('email-password-protection-e2ee');
    expect(plain?.props.accessibilityRole ?? plain?.props.role).toBe('radio');
    expect(plain?.props.accessibilityState).toMatchObject({ checked: true });
    expect(e2ee?.props.accessibilityState).toMatchObject({ checked: false });
});
