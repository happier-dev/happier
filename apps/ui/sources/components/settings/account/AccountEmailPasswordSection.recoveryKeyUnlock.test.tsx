import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { AccountEmailPasswordSection } from './AccountEmailPasswordSection';

/**
 * 02.05 §5.5: an E2EE Account may connect, change or remove its password on a
 * device that holds no recovery secret by entering the existing recovery key
 * locally. The key must never become a dead end, and it must never leave the
 * process except through the existing purpose-bound proof and envelope writers.
 */

const RECOVERY_SECRET = new Uint8Array(32).fill(7);

const auth = vi.hoisted(() => ({
    // Data-key credentials: E2EE, but this device holds no recovery secret.
    credentials: { token: 'token', encryption: { publicKey: 'pk', machineKey: 'mk' } } as Record<string, unknown>,
}));
const scope = vi.hoisted(() => ({
    profile: { id: 'account-a' },
    server: { serverId: 'home-a', serverUrl: 'https://home-a.example.test', generation: 1 },
}));
const recoveryKey = vi.hoisted(() => ({ present: vi.fn() }));
const cryptoBoundary = vi.hoisted(() => ({ prepareChange: vi.fn(), prepareRemove: vi.fn() }));
const modal = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn(async () => true), show: vi.fn(() => 'modal-id') }));

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/storage')>()),
    useProfile: () => scope.profile,
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => scope.server }));
vi.mock('@/auth/flows/resolveHomeAuthenticationTarget', () => ({
    resolveHomeKeyChallengeExpectedAudience: () => ({
        origin: 'https://home-a.example.test',
        serverIdentityId: 'identity-a',
    }),
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>()),
    captureActiveServerAccountScopeCurrentness: () => ({
        isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }),
    }),
}));
vi.mock('@/sync/api/auth/accountSecurity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/api/auth/accountSecurity')>()),
    prepareE2eeAccountPasswordChange: cryptoBoundary.prepareChange,
    prepareE2eeAccountPasswordRemove: cryptoBoundary.prepareRemove,
}));
vi.mock('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth', () => ({
    clearAccountPasswordEnrollmentExternalAuthCustody: vi.fn(async () => true),
    readAccountPasswordEnrollmentExternalAuthProof: vi.fn(async () => null),
    startAccountPasswordEnrollmentExternalAuth: vi.fn(),
    openAccountPasswordEnrollmentExternalAuthSession: vi.fn(),
}));
vi.mock('./presentAccountRecoveryKeyEntry', () => ({
    presentAccountRecoveryKeyEntry: recoveryKey.present,
}));
vi.mock('@/modal', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/modal')>()),
    Modal: { alert: modal.alert, confirm: modal.confirm, show: modal.show },
}));

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    auth.credentials = { token: 'token', encryption: { publicKey: 'pk', machineKey: 'mk' } };
    recoveryKey.present.mockReset().mockResolvedValue(RECOVERY_SECRET.slice());
    cryptoBoundary.prepareChange.mockReset().mockResolvedValue({ v: 1, kind: 'e2ee', action: 'change' });
    cryptoBoundary.prepareRemove.mockReset().mockResolvedValue({ v: 1, kind: 'e2ee' });
    modal.alert.mockReset();
    modal.confirm.mockReset().mockResolvedValue(true);
    modal.show.mockReset().mockReturnValue('modal-id');
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    vi.unstubAllGlobals();
});

function e2eeProjection(status: 'enrolled' | 'not_enrolled') {
    return {
        v: 1 as const,
        encryptionMode: 'e2ee' as const,
        nativeEmail: 'person@example.test',
        password: status === 'enrolled'
            ? { status: 'enrolled' as const, revision: 5 }
            : { status: 'not_enrolled' as const, revision: null },
    };
}

function createClient(status: 'enrolled' | 'not_enrolled' = 'enrolled') {
    return {
        read: vi.fn(async () => e2eeProjection(status)),
        enrollPlainPassword: vi.fn(),
        enrollE2eePassword: vi.fn(async () => ({ v: 1 as const, status: 'enrolled' as const })),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(),
        changeE2eePassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        removePlainPassword: vi.fn(),
        removeE2eePassword: vi.fn(async () => ({ v: 1 as const, status: 'removed' as const })),
        requestEmailChange: vi.fn(),
    };
}

it('opens the password form instead of dead-ending when this device holds no recovery secret', async () => {
    const client = createClient('enrolled');

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');

    expect(modal.alert).not.toHaveBeenCalled();
    expect(screen.findByTestId('settings-account-change-password-form')).not.toBeNull();
});

it('changes the E2EE password with a locally entered recovery key', async () => {
    const client = createClient('enrolled');

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
        screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
    });

    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(client.changeE2eePassword).toHaveBeenCalledTimes(1));
    expect(recoveryKey.present).toHaveBeenCalledTimes(1);
    expect(cryptoBoundary.prepareChange).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ secret: expect.any(Uint8Array), expectedCredentialRevision: 5 }),
    );
});

it('mutates nothing when the recovery-key ceremony is dismissed', async () => {
    const client = createClient('enrolled');
    recoveryKey.present.mockResolvedValue(null);

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
        screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
    });

    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(recoveryKey.present).toHaveBeenCalledTimes(1));
    expect(client.changeE2eePassword).not.toHaveBeenCalled();
    expect(cryptoBoundary.prepareChange).not.toHaveBeenCalled();
});

it('asks for the recovery key only once for consecutive mutations in the same mounted ceremony', async () => {
    const client = createClient('enrolled');

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
        screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(client.changeE2eePassword).toHaveBeenCalledTimes(1));

    await screen.pressByTestIdAsync('settings-account-password-remove');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-remove-password-form')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-remove-password-submit');

    await vi.waitFor(() => expect(client.removeE2eePassword).toHaveBeenCalledTimes(1));
    expect(recoveryKey.present).toHaveBeenCalledTimes(1);
});
