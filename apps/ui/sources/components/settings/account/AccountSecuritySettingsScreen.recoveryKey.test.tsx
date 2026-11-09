import { t } from '@/text';
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountSecurityGetResponseV1 } from '@happier-dev/protocol/auth/accountSecurity';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { AccountSecuritySettingsScreen } from './AccountSecuritySettingsScreen';
import { accountSecurityProjectionScopeKey, readAccountSecurityProjection, resetAccountSecurityProjectionStoreForTests } from './accountSecurityProjectionStore';

const AccountScopeContext = React.createContext({ serverId: 'home-a', accountId: 'account-a' });

type PublishedProjection = AccountSecurityGetResponseV1;

const boundary = vi.hoisted(() => ({
    credentials: { token: 'account-a' } as Record<string, unknown>,
    projection: null as PublishedProjection | null,
    /** While true, the section has not answered yet (its read is still in flight). */
    pending: false,
    profileAccountId: null as string | null,
    read: vi.fn(),
    createClient: vi.fn(),
}));
const modal = vi.hoisted(() => ({
    alert: vi.fn(),
    show: vi.fn(() => 'modal-id'),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: {} }).module;
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { ...boundary.credentials, token: React.useContext(AccountScopeContext).accountId }, refreshFromActiveServer: vi.fn() }),
}));
vi.mock('@/utils/auth/parseToken', () => ({ parseToken: (token: string) => token }));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => {
        const { serverId } = React.useContext(AccountScopeContext);
        return { serverId, serverUrl: `https://${serverId}.test` };
    },
}));
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
    useProfile: () => {
        const { accountId } = React.useContext(AccountScopeContext);
        return { id: boundary.profileAccountId ?? accountId };
    },
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: () => ({ kind: 'bound', scope: React.useContext(AccountScopeContext) }),
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>()),
    captureActiveServerAccountScopeCurrentness: () => ({
        isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }),
    }),
}));
vi.mock('./accountSecurityActionClient', () => ({
    createAccountSecurityActionClient: boundary.createClient,
}));
vi.mock('./openAccountSecurityForHome', () => ({
    ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT: 'email_password_connect',
    openAccountSecurityForHome: vi.fn(async () => true),
}));
vi.mock('./AccountEmailPasswordSection', () => ({
    AccountEmailPasswordSection: (props: Readonly<{ onProjection?: (value: PublishedProjection | null) => void }>) => {
        React.useEffect(() => {
            if (boundary.pending) return;
            props.onProjection?.(boundary.projection);
        }, [props]);
        return React.createElement('AccountEmailPasswordSection', { testID: 'account-security-section' });
    },
}));
vi.mock('./AccountEncryptionSettingsSection', () => ({ AccountEncryptionSettingsSection: () => null }));
vi.mock('./AccountSessionSecuritySection', () => ({ AccountSessionSecuritySection: () => null }));
vi.mock('@/components/settings/SettingsCatalogOverviewGroup', () => ({ SettingsCatalogPageChildren: () => null }));
vi.mock('@/modal', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/modal')>()),
    Modal: { alert: modal.alert, show: modal.show },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

beforeEach(() => {
    resetAccountSecurityProjectionStoreForTests();
    boundary.credentials = { token: 'account-a' };
    boundary.projection = null;
    boundary.pending = false;
    boundary.profileAccountId = null;
    boundary.read.mockReset();
    // No second reader may exist for this projection: any call is a defect.
    boundary.read.mockImplementation(async () => { throw new Error('unexpected_second_projection_read'); });
    boundary.createClient.mockReset();
    boundary.createClient.mockImplementation(() => ({ read: boundary.read }));
    modal.alert.mockReset();
    modal.show.mockReset().mockReturnValue('modal-id');
});

afterEach(() => standardCleanup());

it('reads the Account Security projection exactly once through its one mounted owner', async () => {
    boundary.projection = {
        v: 1,
        encryptionMode: 'e2ee',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 3 },
    };

    const screen = await renderScreen(<AccountSecuritySettingsScreen />);

    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());
    expect(boundary.read).not.toHaveBeenCalled();
});

it('explains an unavailable recovery key instead of leaving the row inert', async () => {
    boundary.credentials = { token: 'account-a', encryption: { publicKey: 'pk', machineKey: 'mk' } };
    boundary.projection = {
        v: 1,
        encryptionMode: 'e2ee',
        nativeEmail: null,
        password: { status: 'not_enrolled', revision: null },
    };

    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-recovery-key');

    expect(modal.show).not.toHaveBeenCalled();
    expect(modal.alert).toHaveBeenCalledTimes(1);
});

it('opens the recovery-key unlock host for an E2EE Account that still has a sign-in email', async () => {
    boundary.credentials = { token: 'account-a', encryption: { publicKey: 'pk', machineKey: 'mk' } };
    boundary.projection = {
        v: 1,
        encryptionMode: 'e2ee',
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision: 2 },
    };

    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-recovery-key');

    expect(modal.alert).not.toHaveBeenCalled();
    expect(modal.show).toHaveBeenCalledTimes(1);
});

it('withdraws the recovery-key row when the canonical projection becomes unavailable', async () => {
    boundary.projection = null;

    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('account-security-section')).not.toBeNull());

    expect(screen.findByTestId('settings-account-recovery-key')).toBeNull();
    expect(screen.findByTestId('settings-account-recovery-key-not-applicable')).toBeNull();
    // The row says what it could not read, not a sentence borrowed from Home discovery.
    const unavailable = screen.findAll((node) => node.props?.testID === 'settings-account-recovery-key-unavailable' && 'subtitle' in node.props)[0];
    expect(unavailable?.props.subtitle).toBe(t('settingsAccount.nativePassword.securityFactUnavailable'));
});

it('preserves a known E2EE recovery action when its projection refresh fails', async () => {
    await readAccountSecurityProjection(accountSecurityProjectionScopeKey('home-a', 'account-a'), async () => ({
        v: 1, encryptionMode: 'e2ee', nativeEmail: 'person@example.test', password: { status: 'enrolled', revision: 2 },
    }));
    boundary.projection = null;
    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull();
    expect(screen.findByTestId('settings-account-recovery-key-not-applicable')).toBeNull();
});

it('does not carry the previous Account recovery action into a pending new scope', async () => {
    boundary.projection = { v: 1, encryptionMode: 'e2ee', nativeEmail: 'old@example.test', password: { status: 'enrolled', revision: 2 } };
    const screen = await renderScreen(<AccountScopeContext.Provider value={{ serverId: 'home-a', accountId: 'account-a' }}>
        <AccountSecuritySettingsScreen />
    </AccountScopeContext.Provider>);
    expect(screen.findByTestId('settings-account-recovery-key')).not.toBeNull();

    boundary.pending = true;
    await screen.update(<AccountScopeContext.Provider value={{ serverId: 'home-b', accountId: 'account-b' }}>
        <AccountSecuritySettingsScreen />
    </AccountScopeContext.Provider>);
    expect(screen.findByTestId('settings-account-recovery-key')).toBeNull();
    expect(screen.findByTestId('settings-account-recovery-key-loading')).not.toBeNull();
});

it('holds the recovery-key place while the projection is still loading, so nothing inserts later', async () => {
    boundary.pending = true;

    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('account-security-section')).not.toBeNull());

    // Held by a quiet placeholder row announced as busy, not a "Loading…" value.
    expect(screen.findHostByTestId('settings-account-recovery-key-loading')?.props.accessibilityState).toEqual({ busy: true });
    expect(screen.getTextContent()).not.toContain('common.loading');
    expect(screen.findByTestId('settings-account-recovery-key')).toBeNull();
});

it('uses the bound credential Account while the previous profile is still visible', async () => {
    boundary.projection = { v: 1, encryptionMode: 'e2ee', nativeEmail: 'old@example.test', password: { status: 'enrolled', revision: 2 } };
    const screen = await renderScreen(<AccountScopeContext.Provider value={{ serverId: 'home-a', accountId: 'account-a' }}>
        <AccountSecuritySettingsScreen />
    </AccountScopeContext.Provider>);
    expect(screen.findByTestId('settings-account-recovery-key') !== null).toBe(true);

    boundary.pending = true;
    boundary.profileAccountId = 'account-a';
    await screen.update(<AccountScopeContext.Provider value={{ serverId: 'home-a', accountId: 'account-b' }}>
        <AccountSecuritySettingsScreen />
    </AccountScopeContext.Provider>);
    expect(screen.findByTestId('settings-account-recovery-key') === null).toBe(true);
    expect(screen.findByTestId('settings-account-recovery-key-loading') !== null).toBe(true);
});
