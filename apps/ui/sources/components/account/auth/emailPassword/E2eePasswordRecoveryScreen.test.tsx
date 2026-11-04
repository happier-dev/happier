import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

import { E2eePasswordRecoveryScreen } from './E2eePasswordRecoveryScreen';

const boundary = vi.hoisted(() => ({
    authGetTokenAtEndpoint: vi.fn(),
    fetchAccountSecurity: vi.fn(),
    prepare: vi.fn(),
    submit: vi.fn(),
    loginWithCredentials: vi.fn(),
    refreshFromActiveServer: vi.fn(),
    setActiveServerAndSwitch: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ replace: boundary.replace, back: boundary.back }) }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/components/onboarding/ui/AuthRouteStepFrame', async () => {
    const ReactModule = await import('react');
    return {
        AuthRouteStepFrame: (props: React.PropsWithChildren<Record<string, unknown>>) => ReactModule.createElement(
            'AuthRouteStepFrame',
            props,
            (props.context as React.ReactNode) ?? null,
            props.children,
            typeof props.onBack === 'function'
                ? ReactModule.createElement('button', {
                    testID: `${String(props.testID)}-back`,
                    onPress: props.onBack,
                })
                : null,
            props.primary && typeof (props.primary as { onPress?: unknown }).onPress === 'function'
                ? ReactModule.createElement('button', {
                    testID: `${String(props.testID)}-primary`,
                    onPress: (props.primary as { onPress: () => void }).onPress,
                })
                : null,
        ),
    };
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        loginWithCredentials: boundary.loginWithCredentials,
        refreshFromActiveServer: boundary.refreshFromActiveServer,
    }),
}));
vi.mock('@/auth/flows/getToken', () => ({ authGetTokenAtEndpoint: boundary.authGetTokenAtEndpoint }));
vi.mock('@/components/account/presentFirstKeyCredentialLifecycle', () => ({
    presentFirstKeyCredentialLifecycle: async ({ run, onCompleted }: { run: () => Promise<{ kind: string }>; onCompleted: () => void }) => {
        const result = await run();
        if (result.kind === 'completed') onCompleted();
    },
}));
vi.mock('@/sync/api/auth/accountSecurity', () => ({
    fetchAccountSecurity: boundary.fetchAccountSecurity,
    prepareE2eeAccountPasswordChange: boundary.prepare,
    submitE2eeAccountPasswordChange: boundary.submit,
}));
// The portable Home link owner, the profile/identity owner and the Home
// authentication target resolver stay real, so a recovery that reached a Home
// this device has not genuinely saved and identity-matched fails here.
// Focus itself stays real: `focusExactHomeAndRefresh` decides `requireExactProfile`,
// the already-active refresh, and the blocked/failed outcome. Only the connection
// switch underneath it — a genuine runtime boundary — is replaced.
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: boundary.setActiveServerAndSwitch,
}));
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    createServerFetchAtEndpoint: () => vi.fn(),
}));
vi.mock('@/track', () => ({ trackAccountRestored: vi.fn() }));

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let homeAProfileId = '';
let homeBProfileId = '';

const HOME_A_URL = 'https://home-a.example.test';
const HOME_B_URL = 'https://home-b.example.test';

beforeEach(async () => {
    boundary.refreshFromActiveServer.mockResolvedValue(undefined);
    boundary.setActiveServerAndSwitch.mockResolvedValue('switched');
    homeAProfileId = (await upsertServerProfile({ serverUrl: HOME_A_URL, name: 'Home A' })).id;
    await setServerProfileIdentityForUrl(HOME_A_URL, 'srv_home_a');
    homeBProfileId = (await upsertServerProfile({ serverUrl: HOME_B_URL, name: 'Home B' })).id;
    await setServerProfileIdentityForUrl(HOME_B_URL, 'srv_home_b');
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    await standardCleanup();
    vi.clearAllMocks();
});

it('can leave recovery before proving a key without authenticating or mutating anything', async () => {
    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_a" />);
    await act(async () => {});

    await screen.pressByTestIdAsync('e2ee-password-recovery-back');

    expect(boundary.back).toHaveBeenCalledOnce();
    expect(boundary.authGetTokenAtEndpoint).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(boundary.submit).not.toHaveBeenCalled();
});

it('names the Home being recovered by its label, not its raw address', async () => {
    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_a" />);
    await act(async () => {});

    expect(screen.findHostByTestId('e2ee-password-recovery-home')?.props.accessibilityLabel).toBe('Home A');
    expect(screen.findAll((node) => node.props.children === HOME_A_URL)).toHaveLength(0);
});

it('replaces the E2EE password through one existing-Account key proof before persisting exact-Home credentials', async () => {
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-1' })), 'base64url')}.signature`;
    boundary.authGetTokenAtEndpoint.mockResolvedValue({ token });
    boundary.fetchAccountSecurity.mockResolvedValue({
        v: 1,
        encryptionMode: 'e2ee',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 7 },
    });
    boundary.prepare.mockResolvedValue({ v: 1, kind: 'e2ee', action: 'recover' });
    boundary.submit.mockResolvedValue(undefined);
    boundary.loginWithCredentials.mockResolvedValue({ kind: 'completed' });

    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_a" />);
    await act(async () => {});

    const secret = new Uint8Array(32).fill(9);
    const key = encodeBase64(secret, 'base64url');
    await act(async () => {
        screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(key);
    });
    await screen.pressByTestIdAsync('restore-manual-submit');

    expect(boundary.authGetTokenAtEndpoint).toHaveBeenCalledOnce();
    expect(boundary.authGetTokenAtEndpoint.mock.calls[0]?.[0]).toMatchObject({
        requireExistingAccount: true,
        requireKeyChallengeV2: true,
        serverIdentityId: 'srv_home_a',
    });

    await act(async () => {
        screen!.findByTestId('e2ee-password-recovery-password')!.props.onChangeText('a genuinely long replacement password');
        screen!.findByTestId('e2ee-password-recovery-confirm')!.props.onChangeText('a genuinely long replacement password');
    });
    await screen.pressByTestIdAsync('e2ee-password-recovery-primary');

    expect(boundary.prepare).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
        action: 'recover',
        accountId: 'account-1',
        expectedCredentialRevision: 7,
        normalizedNativeEmail: 'person@example.test',
    }));
    expect(boundary.submit).toHaveBeenCalledOnce();
    expect(boundary.loginWithCredentials).toHaveBeenCalledWith(
        { token, secret: key },
        { target: { serverUrl: HOME_A_URL, serverId: homeAProfileId } },
    );
    expect(boundary.replace).toHaveBeenCalledWith('/');
});

async function recoverOnHomeB(): Promise<void> {
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-b' })), 'base64url')}.signature`;
    boundary.authGetTokenAtEndpoint.mockResolvedValue({ token });
    boundary.fetchAccountSecurity.mockResolvedValue({
        v: 1,
        encryptionMode: 'e2ee',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 3 },
    });
    boundary.prepare.mockResolvedValue({ v: 1, kind: 'e2ee', action: 'recover' });
    boundary.submit.mockResolvedValue(undefined);
    boundary.loginWithCredentials.mockResolvedValue({ kind: 'completed' });

    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_b" />);
    await act(async () => {});
    await act(async () => {
        screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(
            encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
        );
    });
    await screen!.pressByTestIdAsync('restore-manual-submit');
    await act(async () => {
        screen!.findByTestId('e2ee-password-recovery-password')!.props.onChangeText('a genuinely long replacement password');
        screen!.findByTestId('e2ee-password-recovery-confirm')!.props.onChangeText('a genuinely long replacement password');
    });
    await screen!.pressByTestIdAsync('e2ee-password-recovery-primary');
}

it('activates the exact recovered Home before showing its content, with another Home focused', async () => {
    await recoverOnHomeB();

    // Home A is focused and this credential belongs to Home B. Replacing the
    // route without moving focus would leave the person looking at Home A.
    expect(boundary.setActiveServerAndSwitch).toHaveBeenCalledWith({
        serverId: homeBProfileId,
        scope: 'device',
        refreshAuth: boundary.refreshFromActiveServer,
        requireExactProfile: true,
    });
    expect(boundary.replace).toHaveBeenCalledWith('/');
});

it('stays on recovery with a retry when the recovered Home cannot be activated', async () => {
    boundary.setActiveServerAndSwitch.mockResolvedValue('blocked');

    await recoverOnHomeB();

    expect(boundary.replace).not.toHaveBeenCalled();
    expect(screen!.findByTestId('e2ee-password-recovery-destination-home')).not.toBeNull();
    // The password is already replaced; retry re-runs only the activation.
    boundary.setActiveServerAndSwitch.mockResolvedValue('switched');
    await screen!.pressByTestIdAsync('e2ee-password-recovery-primary');
    expect(boundary.submit).toHaveBeenCalledOnce();
    expect(boundary.replace).toHaveBeenCalledWith('/');
});

it('does not expose password replacement or persist credentials for a Plain Account', async () => {
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-plain' })), 'base64url')}.signature`;
    boundary.authGetTokenAtEndpoint.mockResolvedValue({ token });
    boundary.fetchAccountSecurity.mockResolvedValue({
        v: 1,
        encryptionMode: 'plain',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 2 },
    });

    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_a" />);
    await act(async () => {});
    await act(async () => {
        screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(
            encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
        );
    });
    await screen.pressByTestIdAsync('restore-manual-submit');

    expect(screen.findByTestId('e2ee-password-recovery-password')).toBeNull();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(boundary.submit).not.toHaveBeenCalled();
    expect(boundary.loginWithCredentials).not.toHaveBeenCalled();
});

it('keeps a rejected recovery key effect-free', async () => {
    boundary.authGetTokenAtEndpoint.mockRejectedValueOnce(new Error('wrong key'));

    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_a" />);
    await act(async () => {});
    await act(async () => {
        screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(
            encodeBase64(new Uint8Array(32).fill(5), 'base64url'),
        );
    });
    await screen.pressByTestIdAsync('restore-manual-submit');

    expect(screen.findByTestId('e2ee-password-recovery-password')).toBeNull();
    expect(boundary.fetchAccountSecurity).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(boundary.submit).not.toHaveBeenCalled();
    expect(boundary.loginWithCredentials).not.toHaveBeenCalled();
});

it('retires the proven Account when the person backs out before choosing a password', async () => {
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-1' })), 'base64url')}.signature`;
    boundary.authGetTokenAtEndpoint.mockResolvedValue({ token });
    boundary.fetchAccountSecurity.mockResolvedValue({
        v: 1,
        encryptionMode: 'e2ee',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 7 },
    });

    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_a" />);
    await act(async () => {});
    await act(async () => {
        screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(
            encodeBase64(new Uint8Array(32).fill(6), 'base64url'),
        );
    });
    await screen.pressByTestIdAsync('restore-manual-submit');
    expect(screen.findByTestId('e2ee-password-recovery-password')).not.toBeNull();

    await screen.pressByTestIdAsync('e2ee-password-recovery-back');

    expect(screen.findByTestId('restore-manual-secret-input')).not.toBeNull();
    expect(screen.findByTestId('e2ee-password-recovery-password')).toBeNull();
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(boundary.submit).not.toHaveBeenCalled();
    expect(boundary.loginWithCredentials).not.toHaveBeenCalled();
});

it('retires password preparation before effects when the exact Home target changes', async () => {
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-1' })), 'base64url')}.signature`;
    boundary.authGetTokenAtEndpoint.mockResolvedValue({ token });
    boundary.fetchAccountSecurity.mockResolvedValue({
        v: 1,
        encryptionMode: 'e2ee',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 7 },
    });
    let finishPreparation!: (value: { v: 1; kind: 'e2ee'; action: 'recover' }) => void;
    boundary.prepare.mockReturnValueOnce(new Promise((resolve) => { finishPreparation = resolve; }));

    screen = await renderScreen(<E2eePasswordRecoveryScreen homeTarget="srv_home_a" />);
    await act(async () => {});
    await act(async () => {
        screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(
            encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        );
    });
    await screen.pressByTestIdAsync('restore-manual-submit');
    await act(async () => {
        screen!.findByTestId('e2ee-password-recovery-password')!.props.onChangeText('a genuinely long replacement password');
        screen!.findByTestId('e2ee-password-recovery-confirm')!.props.onChangeText('a genuinely long replacement password');
        screen!.pressByTestId('e2ee-password-recovery-primary');
        await Promise.resolve();
    });

    await screen.update(<E2eePasswordRecoveryScreen homeTarget="srv_home_b" />);
    await vi.waitFor(() => expect(screen?.findByTestId('restore-manual-secret-input')).not.toBeNull());
    await act(async () => {
        finishPreparation({ v: 1, kind: 'e2ee', action: 'recover' });
        await Promise.resolve();
    });

    expect(boundary.submit).not.toHaveBeenCalled();
    expect(boundary.loginWithCredentials).not.toHaveBeenCalled();
});
