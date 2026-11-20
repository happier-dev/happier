import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { NativeAuthEmailAcceptedResponseV1Schema, NativeEmailPasswordLoginResponseV1Schema, NativeEmailPasswordPreloginResponseV1Schema, NativeEmailPasswordProvisionRequestV1Schema, NativeEmailPasswordProvisionResponseV1Schema, NativeEmailVerifyRequestV1Schema, NativePasswordResetRequestV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { EmailPasswordAuthPanel } from './EmailPasswordAuthPanel';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

let TARGET = {
    endpointUrl: 'https://home-a.example.test',
    canonicalServerUrl: 'https://home-a.example.test',
    addressAnchorUrl: 'https://home-a.example.test',
    serverId: 'home-a',
    serverIdentityId: 'srv_home_a',
};

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

beforeEach(async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Home A', serverUrl: TARGET.endpointUrl, serverIdentityId: TARGET.serverIdentityId, accountId: null });
    TARGET = { ...TARGET, serverId };
    homes.answer(serverId, '/v1/auth/email/verify/request', { body: NativeAuthEmailAcceptedResponseV1Schema.parse({ accepted: true }) });
    homes.answer(serverId, '/v1/auth/password/reset/request', { body: NativeAuthEmailAcceptedResponseV1Schema.parse({ accepted: true }) });
    homes.answer(serverId, '/v1/auth/email/prelogin', { body: NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' }) });
    homes.answer(serverId, '/v1/auth/email/login', { body: NativeEmailPasswordLoginResponseV1Schema.parse({ token: 'signed-in' }) });
    homes.answer(serverId, '/v1/auth/email/provision', { body: NativeEmailPasswordProvisionResponseV1Schema.parse({ token: 'created', accountId: 'account-a', teamId: null }) });
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    router.push.mockReset();
    await homes.reset();
    await standardCleanup();
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

    expect(NativeEmailVerifyRequestV1Schema.parse(homes.requestsFor('/v1/auth/email/verify/request')[0]?.input)).toEqual({ v: 1, email: 'person@example.test' });
    expect(homes.requestsFor('/v1/auth/email/provision')).toHaveLength(0);
});

it('collects the password once the mailbox is already proven and creates the Account with the chosen protection', async () => {
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

    expect(NativeEmailPasswordProvisionRequestV1Schema.parse(homes.requestsFor('/v1/auth/email/provision')[0]?.input)).toEqual({
        v: 1, email: 'person@example.test', account: { mode: 'plain', password: 'a sufficiently long password' }, admission,
    });
});

it('marks its own actions busy until authentication answers, in every host', async () => {
    let release = (): void => {};
    homes.answer(TARGET.serverId, '/v1/auth/email/login', { body: NativeEmailPasswordLoginResponseV1Schema.parse({ token: 'signed-in' }), respondAfter: new Promise<void>(resolve => { release = resolve; }) });
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
    expect(homes.requestsFor('/v1/auth/email/verify/request')).toHaveLength(2);
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

it('shows an inline Back from the initial reset request only when the host can go back', async () => {
    screen = await renderPanel({ passwordReset: 'email', initialView: 'forgot' });
    expect(screen.findByTestId('email-password-request-reset')).not.toBeNull();
    expect(screen.findByTestId('email-password-forgot-back')).toBeNull();
    await screen.unmount();

    const onBack = vi.fn();
    screen = await renderPanel({ passwordReset: 'email', initialView: 'forgot', onBack });
    await screen.pressByTestIdAsync('email-password-forgot-back');
    expect(onBack).toHaveBeenCalledOnce();
});

it('shows the reset request its own field error and submits from the address field', async () => {
    screen = await renderPanel({ action: 'login', passwordReset: 'email' });
    await screen.pressByTestIdAsync('email-password-forgot');

    await screen.pressByTestIdAsync('email-password-request-reset');
    const emptyError = screen.findByTestId('email-password-email-error');
    expect(emptyError).not.toBeNull();
    expect(screen.findByTestId('email-password-email')?.props['aria-describedby'])
        .toContain(emptyError?.props.nativeID);
    expect(homes.requestsFor('/v1/auth/password/reset/request')).toHaveLength(0);

    // The same address acceptance the rest of this surface uses, not a bare
    // emptiness check: a malformed address is refused before the request.
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('not-an-address');
    });
    await screen.pressByTestIdAsync('email-password-request-reset');
    expect(screen.findByTestId('email-password-email-error')).not.toBeNull();
    expect(homes.requestsFor('/v1/auth/password/reset/request')).toHaveLength(0);

    // There is no password field in this view, so Return submits the request.
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
    });
    const field = screen.findByTestId('email-password-email');
    expect(field?.props.returnKeyType).toBe('go');
    await act(async () => { field!.props.onSubmitEditing(); });
    await vi.waitFor(() => expect(homes.requestsFor('/v1/auth/password/reset/request')).toHaveLength(1));
    expect(NativePasswordResetRequestV1Schema.parse(homes.requestsFor('/v1/auth/password/reset/request')[0]?.input)).toEqual({ v: 1, email: 'person@example.test' });
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
