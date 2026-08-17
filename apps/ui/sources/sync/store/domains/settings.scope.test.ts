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
    activateSettingsScope?: (scope: AccountSettingsScope, legacyScopes?: readonly AccountSettingsScope[]) => void;
    applySettingsForScope?: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    replaceSettingsForScope?: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    clearSettingsScope?: () => void;
}>;

type TestState = ScopedSettingsDomain & Readonly<{
    sessions: {};
    machines: {};
    machineDisplayById: {};
    sessionListRenderables: {};
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
        sessionListRenderables: {},
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
    'activateSettingsScope' | 'applySettingsForScope' | 'replaceSettingsForScope' | 'clearSettingsScope'
>> {
    expect(state.activateSettingsScope, 'settings domain should expose activateSettingsScope').toBeTypeOf('function');
    expect(state.applySettingsForScope, 'settings domain should expose applySettingsForScope').toBeTypeOf('function');
    expect(state.replaceSettingsForScope, 'settings domain should expose replaceSettingsForScope').toBeTypeOf('function');
    expect(state.clearSettingsScope, 'settings domain should expose clearSettingsScope').toBeTypeOf('function');
}

describe('createSettingsDomain scoped account settings', () => {
    const scopeA = { serverId: 'server-a', accountId: 'account-a' };
    const scopeB = { serverId: 'server-b', accountId: 'account-b' };

    beforeEach(() => {
        clearPersistence();
    });

    it('hydrates the active projection when switching to a lower-version settings scope', () => {
        saveAccountSettings(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 9);
        saveAccountSettings(scopeB, { ...settingsDefaults, analyticsOptOut: false, crashReportsOptOut: true }, 4);

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA);
        expect(getState().settingsScope).toEqual(scopeA);
        expect(getState().settingsVersion).toBe(9);
        expect(getState().settings.analyticsOptOut).toBe(true);

        getState().activateSettingsScope(scopeB);
        expect(getState().settingsScope).toEqual(scopeB);
        expect(getState().settingsVersion).toBe(4);
        expect(getState().settings.analyticsOptOut).toBe(false);
        expect(getState().settings.crashReportsOptOut).toBe(true);
    });

    it('migrates local-only legacy cache and preserves legacy pending edits on first scoped activation', () => {
        store.set('settings', JSON.stringify({
            settings: {
                ...settingsDefaults,
                analyticsOptOut: true,
                lastUsedAgent: 'codex',
                terminalConnectLegacySecretExportEnabled: true,
            },
            version: 22,
        }));
        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true, viewInline: true }));

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA);

        expect(getState().settingsScope).toEqual(scopeA);
        expect(getState().settingsVersion).toBeNull();
        expect(getState().settings.lastUsedAgent).toBe('codex');
        expect(getState().settings.terminalConnectLegacySecretExportEnabled).toBe(true);
        expect(getState().settings.analyticsOptOut).toBe(settingsDefaults.analyticsOptOut);
        expect(store.has('settings')).toBe(false);
        expect(store.has('pending-settings')).toBe(false);
        expect(loadAccountSettings(scopeA)).toMatchObject({
            settings: expect.objectContaining({
                lastUsedAgent: 'codex',
                terminalConnectLegacySecretExportEnabled: true,
                analyticsOptOut: settingsDefaults.analyticsOptOut,
            }),
            version: null,
        });
        expect(loadPendingAccountSettings(scopeA)).toEqual({ analyticsOptOut: true, viewInline: true });
    });

    it('forwards explicit legacy identity scopes without reviving retired organization settings', () => {
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        saveAccountSettings(legacyScope, {
            ...settingsDefaults,
            lastUsedAgent: 'codex',
        }, 7);

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA, [legacyScope]);

        expect(getState().settings.lastUsedAgent).toBe('codex');
        expect(loadPendingAccountSettings(scopeA)).toEqual({});
    });

    it('hydrates purchases from explicit legacy identity scopes during scoped activation', () => {
        const legacyScope = { serverId: 'localhost-18829', accountId: 'account-a' };
        saveAccountPurchases(legacyScope, {
            ...purchasesDefaults,
            activeSubscriptions: ['pro'],
            entitlements: { pro: true },
        });

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA, [legacyScope]);

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

    it('does not re-migrate legacy settings over an existing scoped settings cache', () => {
        store.set('settings', JSON.stringify({
            settings: {
                ...settingsDefaults,
                lastUsedAgent: 'codex',
            },
            version: 10,
        }));

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA);
        expect(getState().settings.lastUsedAgent).toBe('codex');

        store.set('settings', JSON.stringify({
            settings: {
                ...settingsDefaults,
                analyticsOptOut: true,
                lastUsedAgent: 'claude',
            },
            version: 99,
        }));
        store.set('pending-settings', JSON.stringify({ analyticsOptOut: true }));

        getState().activateSettingsScope(scopeA);

        expect(getState().settings.lastUsedAgent).toBe('codex');
        expect(getState().settings.analyticsOptOut).toBe(settingsDefaults.analyticsOptOut);
        expect(store.has('settings')).toBe(false);
        expect(store.has('pending-settings')).toBe(false);
        expect(loadAccountSettings(scopeA)).toMatchObject({
            settings: expect.objectContaining({
                lastUsedAgent: 'codex',
                analyticsOptOut: settingsDefaults.analyticsOptOut,
            }),
            version: null,
        });
    });

    it('ignores older remote settings only within the same scope', () => {
        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA);
        getState().applySettingsForScope(scopeA, { ...settingsDefaults, analyticsOptOut: true }, 5);
        getState().applySettingsForScope(scopeA, { ...settingsDefaults, analyticsOptOut: false }, 4);

        expect(getState().settingsVersion).toBe(5);
        expect(getState().settings.analyticsOptOut).toBe(true);
    });

    it('does not let a stale different-scope update mutate the active projection', () => {
        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA);
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

    it('persists local settings writes only to the active settings scope', () => {
        saveAccountSettings(scopeB, { ...settingsDefaults, analyticsOptOut: false }, 2);

        const { getState } = createTestStore();
        requireScopedMethods(getState());

        getState().activateSettingsScope(scopeA);
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
