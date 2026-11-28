import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { renderScreen, standardCleanup, createDeferred } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

const modal = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn<() => Promise<boolean>>(), show: vi.fn((_config: unknown) => 'modal-id') }));
installSettingsViewCommonModuleMocks({ storage: 'real', modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: modal }).module });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { AccountSecuritySettingsScreen } = await import('./AccountSecuritySettingsScreen');
const { resetAccountSecurityProjectionStoreForTests } = await import('./accountSecurityProjectionStore');
const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
const { getCurrentAuth } = await import('@/auth/context/currentAuth');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreExecutor: (() => void) | undefined;
let homeId: string;
let credentials: AuthCredentials;

beforeEach(async () => {
    installHomeGovernanceBoundaries(homes);
    restoreExecutor = await installRealActionExecutorModuleLoader();
    resetAccountSecurityProjectionStoreForTests(); modal.alert.mockClear(); modal.show.mockClear();
    modal.confirm.mockReset();
});
afterEach(async () => {
    standardCleanup(); await connection?.dispose(); connection = undefined;
    restoreExecutor?.(); await homes.reset();
});

function projection(mode: 'plain' | 'e2ee' = 'e2ee', email: string | null = 'person@example.test') {
    return AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: mode, nativeEmail: email,
        password: email ? { status: 'enrolled', revision: 3 } : { status: 'not_enrolled', revision: null } });
}
function accountCredentials(accountId: string, localSecret = false): AuthCredentials {
    const token = createAccountTokenForTests(accountId);
    if (localSecret) return { token, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
    const pair = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(7));
    return { token, encryption: { publicKey: encodeBase64(pair.publicKey), machineKey: encodeBase64(pair.privateKey) } };
}
async function prepare(options: Readonly<{ mode?: 'plain' | 'e2ee'; email?: string | null; localSecret?: boolean }> = {}) {
    const mode = options.mode ?? 'e2ee';
    credentials = mode === 'plain' ? { token: createAccountTokenForTests('account-a') } : accountCredentials('account-a', options.localSecret);
    homeId = await homes.addHome({ name: 'Security Home', serverUrl: 'https://security-recovery-key.example.test', accountId: 'account-a',
        credentials, accountEncryptionMode: mode });
    homes.answer(homeId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    homes.answer(homeId, '/v1/account/security', { body: projection(mode, options.email === undefined ? 'person@example.test' : options.email) });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://security-recovery-key.example.test', credentials,
        request: homes.request, additionalRequestOrigins: ['https://security-recovery-key-b.example.test'] });
}
async function renderSecurity() {
    return renderScreen(<AuthProvider initialCredentials={credentials}><AccountSecuritySettingsScreen /></AuthProvider>);
}

it('reads the security projection once through the real mounted reader', async () => {
    await prepare();
    const screen = await renderSecurity();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    expect(homes.requestsFor('/v1/account/security')).toHaveLength(1);
});

it('opens existing password enrollment from the passwordless Recovery key row', async () => {
    await prepare({ email: null });
    const screen = await renderSecurity();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-recovery-key');
    expect(screen.findByTestId('settings-account-password-enroll-email')).not.toBeNull();
    expect(modal.show).not.toHaveBeenCalled();
});

it.each([false, true])('opens password unlock for an E2EE Account with local recovery key = %s', async (localSecret) => {
    await prepare({ localSecret });
    const screen = await renderSecurity();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-recovery-key');
    expect(modal.alert).not.toHaveBeenCalled(); expect(modal.show).toHaveBeenCalledTimes(1);
    expect(modal.show.mock.calls[0]?.[0]).toMatchObject({ props: { email: 'person@example.test' } });
});

it.each([false, true])('opens a passwordless local key only after confirmation = %s', async (confirmed) => {
    await prepare({ email: null, localSecret: true });
    const confirmation = createDeferred<boolean>();
    modal.confirm.mockReturnValueOnce(confirmation.promise);
    const screen = await renderSecurity();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-recovery-key');
    expect(modal.show).not.toHaveBeenCalled();
    expect(modal.confirm).toHaveBeenCalledOnce();
    await act(async () => { confirmation.resolve(confirmed); });
    expect(modal.show).toHaveBeenCalledTimes(confirmed ? 1 : 0);
});

it('marks a plain Account recovery key as not applicable', async () => {
    await prepare({ mode: 'plain' });
    const screen = await renderSecurity();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key-not-applicable')).not.toBeNull());
    expect(screen.findByTestId('settings-account-recovery-key')).toBeNull();
});

it('reports unavailable recovery facts when their initial HTTP read fails', async () => {
    await prepare(); homes.answer(homeId, '/v1/account/security', { status: 503, body: { error: 'unavailable' } });
    const screen = await renderSecurity();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key-unavailable')).not.toBeNull());
    expect(screen.findByTestId('settings-account-recovery-key')).toBeNull();
    expect(screen.findByTestId('settings-account-recovery-key-not-applicable')).toBeNull();
});

it('preserves a known E2EE recovery action when its next HTTP read fails', async () => {
    await prepare();
    const first = await renderSecurity();
    await vi.waitFor(() => expect(first.findByTestId('settings-account-recovery-key')).not.toBeNull());
    await first.unmount(); homes.answer(homeId, '/v1/account/security', { status: 503, body: { error: 'unavailable' } });
    const screen = await renderSecurity();
    await vi.waitFor(() => expect(homes.requestsFor('/v1/account/security')).toHaveLength(2));
    expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull();
});

it('holds a busy recovery-key placeholder while its real HTTP projection is pending', async () => {
    await prepare(); const pending = createDeferred<void>();
    homes.answer(homeId, '/v1/account/security', { body: projection(), respondAfter: pending.promise });
    try {
        const screen = await renderSecurity();
        await vi.waitFor(() => expect(homes.requestsFor('/v1/account/security')).toHaveLength(1));
        expect(screen.findHostByTestId('settings-account-recovery-key-loading')?.props.accessibilityState).toEqual({ busy: true });
        expect(screen.findByTestId('settings-account-recovery-key')).toBeNull();
        pending.resolve(); await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    } finally { pending.resolve(); }
});

it.each(['account', 'home'] as const)('withdraws the previous recovery action while a new %s projection resolves', async change => {
    await prepare(); const screen = await renderSecurity();
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    const pending = createDeferred<void>();
    const nextCredentials = accountCredentials('account-b');
    const nextHome = change === 'account' ? homeId : await homes.addHome({ name: 'Other Security Home',
        serverUrl: 'https://security-recovery-key-b.example.test', accountId: 'account-b', credentials: nextCredentials,
        accountEncryptionMode: 'e2ee', active: false });
    homes.answer(nextHome, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(nextCredentials) });
    homes.answer(nextHome, '/v1/account/security', { body: projection(), respondAfter: pending.promise });
    try {
        await act(async () => {
            if (change === 'account') await homes.switchAccount(homeId, 'account-b', nextCredentials);
            else await setActiveServerAndSwitch({ serverId: nextHome, refreshAuth: async () => { await getCurrentAuth()?.refreshFromActiveServer(); } });
        });
        await vi.waitFor(() => expect(getCurrentAuth()?.credentials?.token).toBe(createAccountTokenForTests('account-b')));
        await vi.waitFor(() => expect(homes.requestsFor('/v1/account/security')).toHaveLength(2));
        expect(screen.findByTestId('settings-account-recovery-key')).toBeNull();
        expect(screen.findByTestId('settings-account-recovery-key-loading')).not.toBeNull();
        pending.resolve(); await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    } finally { pending.resolve(); }
});
