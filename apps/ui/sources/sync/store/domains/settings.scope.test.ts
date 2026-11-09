import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { purchasesDefaults } from '@/sync/domains/purchases/purchases';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import {
    loadAccountSettings,
    loadPendingAccountSettings,
    saveAccountSettings,
} from '@/sync/domains/state/accountSettingsPersistence';
import {
    loadAccountPurchases,
    saveAccountPurchases,
} from '@/sync/domains/state/accountProfilePersistence';
import { clearPersistence } from '@/sync/domains/state/persistence';
import { readLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

import { createSettingsDomain } from './settings';

type ScopedSettingsDomain = ReturnType<typeof createSettingsDomain> & Readonly<{
    settingsScope: AccountSettingsScope | null;
    activateSettingsScope?: (scope: AccountSettingsScope, legacyScopes?: readonly AccountSettingsScope[]) => Promise<void>;
    applySettingsForScope?: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    clearSettingsScope?: () => void;
}>;

type TestState = ScopedSettingsDomain & Readonly<{
    sessions: {};
    machines: {};
    machineDisplayById: {};
    sessionListRowsByServerId: {};
    ordinarySessionListMembershipByServerId: {};
    archivedSessionListMembershipByServerId: {};
    sessionListIndexByServerId: {};
    concurrentSessionListCacheByServerId: {};
    machineListByServerId: {};
    getProjectForSession: undefined;
}>;

function createTestStore(): { getState: () => TestState; state: TestState } {
    let state = {
        sessions: {},
        machines: {},
        machineDisplayById: {},
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        archivedSessionListMembershipByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        machineListByServerId: {},
        getProjectForSession: undefined,
    } as TestState;

    const set = (updater: ((state: TestState) => Partial<TestState> | TestState) | Partial<TestState>) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    const get = () => state;
    const domain = createSettingsDomain<TestState>({ set, get });
    state = { ...state, ...(domain as ScopedSettingsDomain) };

    return {
        getState: () => state,
        state,
    };
}

function requireScopedMethods(state: ScopedSettingsDomain): asserts state is ScopedSettingsDomain & Required<Pick<
    ScopedSettingsDomain,
    'activateSettingsScope' | 'applySettingsForScope' | 'clearSettingsScope'
>> {
    expect(state.activateSettingsScope, 'settings domain should expose activateSettingsScope').toBeTypeOf('function');
    expect(state.applySettingsForScope, 'settings domain should expose applySettingsForScope').toBeTypeOf('function');
    expect(state.clearSettingsScope, 'settings domain should expose clearSettingsScope').toBeTypeOf('function');
}

describe('createSettingsDomain scoped account settings', () => {
    it('keeps policy status transient, scoped and monotonic with the accepted Settings version', async () => {
        const scope = { serverId: 'policy-home', accountId: 'policy-account' };
        const otherScope = { serverId: 'other-home', accountId: 'other-account' };
        const { getState } = createTestStore();
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, settingsDefaults, 4, 'current');
        expect(getState().settingsRemoteAlertPolicyStatus).toBe('current');
        getState().applySettingsForScope(scope, settingsDefaults, 5, 'stale');
        expect(getState().settingsRemoteAlertPolicyStatus).toBe('stale');
        getState().applySettingsForScope(scope, settingsDefaults, 4, 'current');
        expect(getState().settingsRemoteAlertPolicyStatus).toBe('stale');
        getState().applySettingsForScope(otherScope, settingsDefaults, 99, 'current');
        expect(getState().settingsRemoteAlertPolicyStatus).toBe('stale');
        expect(loadAccountSettings(scope).settings).not.toHaveProperty('settingsRemoteAlertPolicyStatus');
        // An unmarked newer server fact withdraws the optimization, and a fresh
        // baseline may fill metadata for a version already hydrated from disk.
        getState().applySettingsForScope(scope, settingsDefaults, 6);
        expect(getState().settingsRemoteAlertPolicyStatus).toBeNull();
        getState().applySettingsForScope(scope, settingsDefaults, 6, 'current');
        expect(getState().settingsRemoteAlertPolicyStatus).toBe('current');
        await getState().activateSettingsScope(otherScope);
        expect(getState().settingsRemoteAlertPolicyStatus).toBeNull();
        getState().clearSettingsScope();
        expect(getState().settingsRemoteAlertPolicyStatus).toBeNull();
    });

    it('moves a legacy theme binding with a Home alias and persists startup scope through clear', async () => {
        const oldScope = { serverId: 'legacy-server', accountId: 'account-a' };
        const nextScope = { serverId: 'current-server', accountId: 'account-a' };
        const { getState } = createTestStore();
        writeThemeProfileLegacyAccountScope(oldScope);
        await getState().activateSettingsScope(nextScope, [oldScope]);
        expect(readThemeProfileLegacyAccountScope()).toEqual(nextScope);
        expect(JSON.parse(store.get('active-account-settings-scope')!)).toEqual(nextScope);
        getState().clearSettingsScope();
        expect(store.has('active-account-settings-scope')).toBe(false);
    });

    const scopeA = { serverId: 'server-a', accountId: 'account-a' };
    const scopeB = { serverId: 'server-b', accountId: 'account-b' };

    beforeEach(() => {
        clearPersistence();
    });

    it('hydrates the active projection when switching to a lower-version settings scope', async () => {
        saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 9);
        saveAccountSettings(scopeB, { ...settingsDefaults, analyticsOptOut: false, crashReportsOptOut: true }, 4);

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA);
        expect(getState().settingsScope).toEqual(scopeA);
        expect(getState().settingsVersion).toBe(9);
        expect(getState().settings.analyticsOptOut).toBe(true);

        await getState().activateSettingsScope(scopeB);
        expect(getState().settingsScope).toEqual(scopeB);
        expect(getState().settingsVersion).toBe(4);
        expect(getState().settings.analyticsOptOut).toBe(false);
        expect(getState().settings.crashReportsOptOut).toBe(true);
    });

    it('migrates local-only legacy cache and preserves legacy pending edits on first scoped activation', async () => {
        store.set('settings', JSON.stringify({
            settings: {
                ...settingsDefaults,
                analyticsOptOut: true,
                lastUsedAgent: 'codex',
                terminalConnectLegacySecretExportEnabled: true,
            },
            version: 22,
        }));
        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true, showLineNumbers: true }));

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA);

        expect(getState().settingsScope).toEqual(scopeA);
        expect(getState().settingsVersion).toBeNull();
        expect(readLastUsedBackendSelection(scopeA).lastUsedAgent).toBe('codex');
        expect(getState().settings.lastUsedAgent).toBeNull();
        expect(getState().settings.terminalConnectLegacySecretExportEnabled).toBe(true);
        expect(getState().settings.analyticsOptOut).toBe(settingsDefaults.analyticsOptOut);
        expect(store.has('settings')).toBe(false);
        expect(store.has('pending-settings')).toBe(false);
        expect(loadAccountSettings(scopeA)).toMatchObject({
            settings: expect.objectContaining({
                terminalConnectLegacySecretExportEnabled: true,
                analyticsOptOut: settingsDefaults.analyticsOptOut,
            }),
            version: null,
        });
        expect(loadAccountSettings(scopeA).settings).not.toHaveProperty('lastUsedAgent');
        expect(loadPendingAccountSettings(scopeA)).toEqual({ analyticsOptOut: true, showLineNumbers: true });
    });

    it('forwards explicit legacy identity scopes without reviving retired organization settings', async () => {
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        saveAccountSettings(legacyScope, {
            ...settingsDefaults,
            lastUsedAgent: 'codex',
        }, 7);

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA, [legacyScope]);

        expect(readLastUsedBackendSelection(scopeA).lastUsedAgent).toBe('codex');
        expect(getState().settings.lastUsedAgent).toBeNull();
        expect(loadPendingAccountSettings(scopeA)).toEqual({});
    });

    it('hydrates purchases from explicit legacy identity scopes during scoped activation', async () => {
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        saveAccountPurchases(legacyScope, {
            ...purchasesDefaults,
            activeSubscriptions: ['pro'],
            entitlements: { pro: true },
        });

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA, [legacyScope]);

        expect(getState().purchases).toEqual({
            ...purchasesDefaults,
            activeSubscriptions: ['pro'],
            entitlements: { pro: true },
        });
        expect(loadAccountPurchases(scopeA)).toEqual({
            ...purchasesDefaults,
            activeSubscriptions: ['pro'],
            entitlements: { pro: true },
        });
    });

    it('does not re-migrate legacy settings over an existing scoped settings cache', async () => {
        store.set('settings', JSON.stringify({
            settings: {
                ...settingsDefaults,
                lastUsedAgent: 'codex',
            },
            version: 10,
        }));

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA);
        expect(readLastUsedBackendSelection(scopeA).lastUsedAgent).toBe('codex');
        expect(getState().settings.lastUsedAgent).toBeNull();

        store.set('settings', JSON.stringify({
            settings: {
                ...settingsDefaults,
                analyticsOptOut: true,
                lastUsedAgent: 'claude',
            },
            version: 99,
        }));
        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true }));

        await getState().activateSettingsScope(scopeA);

        expect(readLastUsedBackendSelection(scopeA).lastUsedAgent).toBe('codex');
        expect(getState().settings.lastUsedAgent).toBeNull();
        expect(getState().settings.analyticsOptOut).toBe(settingsDefaults.analyticsOptOut);
        expect(store.has('settings')).toBe(false);
        expect(store.has('pending-settings')).toBe(false);
        expect(loadAccountSettings(scopeA)).toMatchObject({
            settings: expect.objectContaining({
                analyticsOptOut: settingsDefaults.analyticsOptOut,
            }),
            version: null,
        });
        expect(loadAccountSettings(scopeA).settings).not.toHaveProperty('lastUsedAgent');
    });

    it('ignores older remote settings only within the same scope', async () => {
        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA);
        getState().applySettingsForScope(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 5);
        getState().applySettingsForScope(scopeA, { ...settingsDefaults, analyticsOptOut: false }, 4);

        expect(getState().settingsVersion).toBe(5);
        expect(getState().settings.analyticsOptOut).toBe(true);
    });

    it('does not let a stale different-scope update mutate the active projection', async () => {
        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA);
        getState().applySettingsForScope(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 5);
        getState().applySettingsForScope(scopeB, { ...settingsDefaults, analyticsOptOut: false, crashReportsOptOut: true }, 10);

        expect(getState().settingsScope).toEqual(scopeA);
        expect(getState().settingsVersion).toBe(5);
        expect(getState().settings.analyticsOptOut).toBe(true);
        expect(loadAccountSettings(scopeB)).toMatchObject({
            settings: expect.objectContaining({ crashReportsOptOut: true }),
            version: 10,
        });
    });

    it('persists local settings writes only to the active settings scope', async () => {
        saveAccountSettings(scopeB, { ...settingsDefaults, analyticsOptOut: false }, 2);

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        await getState().activateSettingsScope(scopeA);
        getState().applySettingsLocal({ analyticsOptOut: true });

        expect(loadAccountSettings(scopeA)).toMatchObject({
            settings: expect.objectContaining({ analyticsOptOut: true }),
            version: 0,
        });
        expect(loadAccountSettings(scopeB)).toMatchObject({
            settings: expect.objectContaining({ analyticsOptOut: false }),
            version: 2,
        });
    });
});
