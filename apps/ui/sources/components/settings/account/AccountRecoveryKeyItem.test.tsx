import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { installBrowserClipboardBoundary, renderScreen, standardCleanup } from '@/dev/testkit';
import { formatRecoveryKeyForDisplay } from '@/auth/recovery/secretKeyBackup';

import { AccountRecoveryKeyItem } from './AccountRecoveryKeyItem';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// A 32-byte recovery secret, as a legacy credential holds it (base64url).
const LOCAL_SECRET = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA';
const UNLOCKED_SECRET = new Uint8Array(32).fill(7);

const boundary = vi.hoisted(() => ({
    credentials: {} as Record<string, unknown>,
    clipboard: [] as string[],
}));
const modal = vi.hoisted(() => ({
    alert: vi.fn(),
    show: vi.fn((_config: unknown) => 'modal-id'),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: boundary.credentials }),
}));
vi.mock('expo-clipboard', () => ({
    setStringAsync: async (value: string) => { boundary.clipboard.push(value); return true; },
}));
vi.mock('@/modal', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/modal')>()),
    Modal: { alert: modal.alert, show: modal.show },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

beforeEach(() => {
    boundary.credentials = { token: 'account-a', secret: LOCAL_SECRET };
    boundary.clipboard = [];
    installBrowserClipboardBoundary(async text => { boundary.clipboard.push(text); });
    modal.alert.mockReset();
    modal.show.mockReset().mockReturnValue('modal-id');
});
afterEach(() => standardCleanup());

it('keeps the key masked until revealed, and forgets it again when hidden', async () => {
    const formatted = formatRecoveryKeyForDisplay(LOCAL_SECRET);
    const screen = await renderScreen(<AccountRecoveryKeyItem recoveryEmail={null} />);

    expect(screen.getTextContent()).not.toContain(formatted);
    await screen.pressByTestIdAsync('settings-account-recovery-key-reveal');
    expect(screen.getTextContent()).toContain(formatted);
    await screen.pressByTestIdAsync('settings-account-recovery-key-reveal');
    expect(screen.getTextContent()).not.toContain(formatted);
});

it('copies the formatted key without revealing it and confirms the copy', async () => {
    const screen = await renderScreen(<AccountRecoveryKeyItem recoveryEmail={null} />);

    await screen.pressByTestIdAsync('settings-account-recovery-key-copy');

    expect(boundary.clipboard).toEqual([formatRecoveryKeyForDisplay(LOCAL_SECRET)]);
    expect(screen.getTextContent()).not.toContain(formatRecoveryKeyForDisplay(LOCAL_SECRET));
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key-copied')).not.toBeNull());
});

it('asks for the sign-in password before revealing a key this device does not hold', async () => {
    boundary.credentials = { token: 'account-a', encryption: { publicKey: 'pk', machineKey: 'mk' } };
    const screen = await renderScreen(<AccountRecoveryKeyItem recoveryEmail="person@example.test" />);

    await screen.pressByTestIdAsync('settings-account-recovery-key-reveal');
    expect(modal.show).toHaveBeenCalledTimes(1);
    expect(screen.getTextContent()).not.toContain(formatRecoveryKeyForDisplay(UNLOCKED_SECRET));

    const unlock = modal.show.mock.calls[0]![0] as { props: { onUnlocked: (secret: Uint8Array) => Promise<void> } };
    await React.act(async () => { await unlock.props.onUnlocked(UNLOCKED_SECRET.slice()); });

    expect(screen.getTextContent()).toContain(formatRecoveryKeyForDisplay(UNLOCKED_SECRET));
});

it('opens an account-service key only through that service password, never from this Home key', async () => {
    const serviceRequest = vi.fn(async () => new Response('{}'));
    const screen = await renderScreen(<AccountRecoveryKeyItem
        recoveryEmail={null}
        source={{ kind: 'account_service', request: serviceRequest, reminderTarget: { kind: 'account_service', serverIdentityId: 'srv_accounts' } }}
        testIDPrefix="svc-recovery-key"
    />);

    await screen.pressByTestIdAsync('svc-recovery-key-reveal');
    // This device holds the Home Account key, which is a different key: it must not be shown.
    expect(screen.getTextContent()).not.toContain(formatRecoveryKeyForDisplay(LOCAL_SECRET));
    expect(modal.show).toHaveBeenCalledTimes(1);
    const unlock = modal.show.mock.calls[0]![0] as { props: {
        email: string | null;
        request: (path: string) => Promise<Response>;
        onUnlocked: (secret: Uint8Array) => Promise<void>;
    } };
    expect(unlock.props.email).toBeNull();
    await unlock.props.request('/v1/auth/email/prelogin');
    expect(serviceRequest).toHaveBeenCalledWith('/v1/auth/email/prelogin', expect.anything(), undefined);

    await React.act(async () => { await unlock.props.onUnlocked(UNLOCKED_SECRET.slice()); });
    expect(screen.getTextContent()).toContain(formatRecoveryKeyForDisplay(UNLOCKED_SECRET));
    await screen.pressByTestIdAsync('svc-recovery-key-reveal');
    expect(screen.getTextContent()).not.toContain(formatRecoveryKeyForDisplay(UNLOCKED_SECRET));
});
