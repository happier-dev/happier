import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import { NativeEmailPasswordPreloginResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeAccountAdmissionV1 } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';

import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { projectAuthEntryMethodCapabilities } from '@/auth/capabilities/authMethodCapabilities';
import { AuthProvider } from '@/auth/context/AuthContext';
import { HomeAuthenticationFlow } from './HomeAuthenticationFlow';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let restore: () => void;
let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
beforeEach(() => {
    restore = installLocalStorageMock().restore;
    boundary.request.mockReset();
    setRuntimeFetch(boundary.request);
    boundary.request.mockResolvedValue(new Response('{}', { status: 404 }));
});
afterEach(async () => { await screen?.unmount(); screen = undefined; restore(); });

async function renderEntry(
    actions: readonly Readonly<{
        action: 'login' | 'provision' | 'connect';
        mode: 'keyed' | 'keyless' | 'either';
        recommendedProvisionMode?: 'plain' | 'e2ee';
        passwordReset?: 'email';
    }>[],
    options: Readonly<{ mailboxProven?: boolean; admission?: NativeAccountAdmissionV1; openChosenAction?: boolean }> = {},
) {
    const fixture = createDirectoryHttpFixture();
    const capabilities = projectAuthEntryMethodCapabilities(AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
        actions: actions.map((row) => ({
            kind: 'authenticate', methodId: 'email_password', action: row.action, mode: row.mode,
            ...(row.recommendedProvisionMode ? { recommendedProvisionMode: row.recommendedProvisionMode } : {}),
            ...(row.passwordReset ? { passwordReset: row.passwordReset } : {}),
            origin: 'home', presentation: { displayName: 'Email and password' },
        })),
    }));
    screen = await renderScreen(<AuthProvider initialCredentials={null}>
        <HomeAuthenticationFlow
            target={{ kind: 'descriptor', descriptor: fixture.home.connectionDescriptor, authority: 'current_connection' }}
            {...(options.admission ? { nativeAdmission: options.admission } : options.mailboxProven
                ? { nativeAdmission: { kind: 'native_email_verification' as const, token: 'V'.repeat(43) } }
                : {})}
            {...(options.openChosenAction ? { openChosenAction: true } : {})}
            actions={capabilities.authenticationActions} returnTo="/" onAuthenticated={vi.fn()} onBack={vi.fn()} />
    </AuthProvider>);
    return screen;
}

it.each(['e2ee', 'plain'] as const)(
    'defaults the Account protection to the Home recommendation (%s) when both modes are permitted',
    async (recommendedProvisionMode) => {
        const rendered = await renderEntry(
            [{ action: 'provision', mode: 'either', recommendedProvisionMode }],
            { mailboxProven: true },
        );

        await rendered.pressByTestIdAsync('home-auth-email_password-provision-either');

        const other = recommendedProvisionMode === 'e2ee' ? 'plain' : 'e2ee';
        const isSelected = (mode: 'plain' | 'e2ee') => {
            const node = rendered.findByTestId(`email-password-protection-${mode}`);
            // The protection is announced as a radio; its checked state is the selection.
            return node?.props.accessibilityState?.checked;
        };
        expect(isSelected(recommendedProvisionMode)).toBe(true);
        expect(isSelected(other)).toBe(false);

        // An explicit choice is the person's, and it survives until they change it.
        await rendered.pressByTestIdAsync(`email-password-protection-${other}`);
        expect(isSelected(other)).toBe(true);
        expect(isSelected(recommendedProvisionMode)).toBe(false);
    },
);

it('omits the protection choice and states the outcome when the Home permits one Account mode', async () => {
    const rendered = await renderEntry([{ action: 'provision', mode: 'keyed' }], { mailboxProven: true });

    await rendered.pressByTestIdAsync('home-auth-email_password-provision-keyed');

    expect(rendered.findByTestId('email-password-protection-plain')).toBeNull();
    expect(rendered.findByTestId('email-password-protection-e2ee')).toBeNull();
    expect(rendered.findByTestId('email-password-protection-fixed')).not.toBeNull();
});

it('offers forgot-password recovery from the login controller without disclosing Account existence', async () => {
    const rendered = await renderEntry([{ action: 'login', mode: 'either', passwordReset: 'email' }]);

    await rendered.pressByTestIdAsync('home-auth-email_password-login-either');
    await rendered.pressByTestIdAsync('email-password-forgot');

    expect(rendered.findByTestId('email-password-request-reset')).not.toBeNull();
    expect(rendered.findByTestId('email-password-use-recovery-key')).not.toBeNull();
    expect(boundary.request).not.toHaveBeenCalled();
});

it('never offers a mailed reset the Home cannot send, keeping the recovery key', async () => {
    const rendered = await renderEntry([{ action: 'login', mode: 'either' }]);

    await rendered.pressByTestIdAsync('home-auth-email_password-login-either');
    await rendered.pressByTestIdAsync('email-password-forgot');

    expect(rendered.findByTestId('email-password-request-reset')).toBeNull();
    expect(rendered.findByTestId('email-password-use-recovery-key')).not.toBeNull();
});

it('keeps the entered address and focuses the password when the Home rejects the credentials', async () => {
    const rendered = await renderEntry([{ action: 'login', mode: 'either' }]);
    await rendered.pressByTestIdAsync('home-auth-email_password-login-either');
    boundary.request.mockImplementation(async (url: string) => (
        url.endsWith('/prelogin')
            ? new Response(JSON.stringify(NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' })))
            : new Response(JSON.stringify({ error: 'authentication_failed' }), { status: 401 })
    ));

    await act(async () => {
        rendered.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        rendered.findByTestId('email-password-password')!.props.onChangeText('a calm sixteen plus password');
    });
    await rendered.pressByTestIdAsync('email-password-submit');

    expect(rendered.findByTestId('email-password-email')!.props.value).toBe('person@example.test');
    expect(rendered.findByTestId('email-password-password-error')).not.toBeNull();
});

it('keeps an addressed invitation and the password draft while the person corrects an email mismatch', async () => {
    const admission = { kind: 'team_invitation' as const, token: 'I'.repeat(43) };
    const rendered = await renderEntry([{ action: 'provision', mode: 'keyless' }], { admission });
    await rendered.pressByTestIdAsync('home-auth-email_password-provision-keyless');
    expect(rendered.findByTestId('email-password-submit')).toBeNull();
    boundary.request.mockResolvedValue(new Response(JSON.stringify({ error: 'email_mismatch' }), { status: 403 }));
    const password = 'a calm sixteen plus password';
    await act(async () => {
        rendered.findByTestId('email-password-email')!.props.onChangeText('different@example.test');
        rendered.findByTestId('email-password-password')!.props.onChangeText(password);
        rendered.findByTestId('email-password-confirm')!.props.onChangeText(password);
    });
    await rendered.pressByTestIdAsync('email-password-create');

    expect(rendered.findByTestId('email-password-email-error')).not.toBeNull();
    expect(rendered.findByTestId('email-password-email')!.props['aria-invalid']).toBe(true);
    expect(rendered.findByTestId('email-password-password-error')).toBeNull();
    expect(rendered.findByTestId('email-password-password')!.props.value).toBe(password);
    expect(rendered.findByTestId('email-password-confirm')!.props.value).toBe(password);
    expect(rendered.findByTestId('email-password-email')!.props.editable).toBe(true);

    boundary.request.mockResolvedValue(new Response(JSON.stringify({ error: 'authentication_failed' }), { status: 401 }));
    await act(async () => {
        rendered.findByTestId('email-password-email')!.props.onChangeText('INVITED@EXAMPLE.TEST');
    });
    await rendered.pressByTestIdAsync('email-password-create');
    const provisionRequests = boundary.request.mock.calls.filter(([url]) => String(url).endsWith('/v1/auth/email/provision'));
    expect(provisionRequests.map(([, init]) => JSON.parse(init.body))).toEqual([
        { v: 1, email: 'different@example.test', admission, account: { mode: 'plain', password } },
        { v: 1, email: 'INVITED@EXAMPLE.TEST', admission, account: { mode: 'plain', password } },
    ]);
    expect(rendered.findByTestId('email-password-email-error')).toBeNull();
    expect(rendered.findByTestId('email-password-password-error')).not.toBeNull();
});

it('shows the form'+"'"+'s own Back link on the method chooser flow but not when the step already has one', async () => {
    const chooser = await renderEntry([{ action: 'login', mode: 'either' }]);
    await chooser.pressByTestIdAsync('home-auth-email_password-login-either');
    expect(chooser.findByTestId('email-password-back')).not.toBeNull();
    await chooser.unmount();
    screen = undefined;

    const chosen = await renderEntry([{ action: 'login', mode: 'either' }], { openChosenAction: true });
    expect(chosen.findByTestId('email-password-submit')).not.toBeNull();
    expect(chosen.findByTestId('email-password-back')).toBeNull();
});
