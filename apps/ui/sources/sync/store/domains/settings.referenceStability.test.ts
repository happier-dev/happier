import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { getPreferredLanguage, setPreferredLanguageFromSettings, t } from '@/text/i18n';
import { es } from '@/text/translations/es';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { isActionEnabledInState, isActionApprovalRequiredInState, resolveActionsSettingsV1FromState } from '@/sync/domains/settings/actionsSettings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import type { CustomerInfo } from '@/sync/domains/purchases/types';
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

type SettingsDomainApi = ReturnType<typeof createSettingsDomain>;

type TestState = SettingsDomainApi & Readonly<{
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

function createTestStore() {
    return createStore<TestState>((set, get) => ({
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
        ...createSettingsDomain<TestState>({ set, get }),
    }));
}

/**
 * A settings echo from the server is re-parsed from scratch (`settingsParse` + secret sealing),
 * so every object/array-valued key arrives as a fresh reference even when nothing changed.
 * `useSettings()` and `useSetting(name)` both subscribe under `useShallow`, so a fresh reference
 * for an object/array key re-renders every consumer app-wide on an echo that changed nothing.
 *
 * These tests pin the projection contract: identical content must not churn references, and a
 * genuine change — remote or local — must still land.
 */
function buildServerEchoSettings(overrides: Partial<Settings> = {}): Settings {
    return {
        ...structuredClone(settingsDefaults),
        favoriteDirectories: ['~/code/happier'],
        favoriteMachines: ['machine-a'],
        ...structuredClone(overrides),
    } as Settings;
}

describe('createSettingsDomain settings projection reference stability', () => {
    const scope: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-a' };

    beforeEach(() => {
        clearPersistence();
        store.clear();
        setPreferredLanguageFromSettings(null);
    });

    it('notifies settings subscribers with the activated loaded locale and suppresses identical echoes', () => {
        const api = createTestStore();
        const observed: Array<{ language: string; copy: string }> = [];
        api.subscribe(() => { observed.push({ language: getPreferredLanguage(), copy: t('tabs.inbox') }); });
        api.getState().applySettingsLocal({ preferredLanguage: 'es' });
        expect(api.getState().settings.preferredLanguage).toBe('es');
        expect(observed).toEqual([{ language: 'es', copy: es.tabs.inbox }]);
        api.getState().applySettingsLocal({ preferredLanguage: 'es' });
        expect(observed).toHaveLength(1);
    });

    it('keeps the settings projection reference when a server echo carries structurally identical settings', async () => {
        const api = createTestStore();
        const { getState } = api;
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const settingsBeforeEcho = getState().settings;
        const favoritesBeforeEcho = settingsBeforeEcho.favoriteDirectories;
        const notified = vi.fn();
        api.subscribe(notified);

        getState().applySettingsForScope(scope, buildServerEchoSettings(), 2);

        expect(getState().settings).toBe(settingsBeforeEcho);
        expect(getState().settings.favoriteDirectories).toBe(favoritesBeforeEcho);
        expect(getState().settingsVersion).toBe(2);
        expect(loadAccountSettings(scope).version).toBe(2);
        expect(notified).toHaveBeenCalledTimes(1);
        const afterVersionChange = getState();
        getState().applySettingsForScope({ ...scope }, buildServerEchoSettings(), 2);
        expect(getState()).toBe(afterVersionChange);
        expect(notified).toHaveBeenCalledTimes(1);
    });

    it('suppresses equal scope activation and clearing while publishing Account changes', async () => {
        const api = createTestStore();
        await api.getState().activateSettingsScope(scope);
        const previous = api.getState();
        const notified = vi.fn();
        api.subscribe(notified);

        await api.getState().activateSettingsScope({ ...scope });
        expect(api.getState()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        await api.getState().activateSettingsScope({ ...scope, accountId: 'account-b' });
        expect(api.getState().settingsScope?.accountId).toBe('account-b');
        expect(api.getState().settings).toBe(previous.settings);
        expect(api.getState().purchases).toBe(previous.purchases);
        expect(notified).toHaveBeenCalledTimes(1);

        api.getState().clearSettingsScope();
        const cleared = api.getState();
        api.getState().clearSettingsScope();
        expect(api.getState()).toBe(cleared);
        expect(notified).toHaveBeenCalledTimes(2);
    });

    it('suppresses equal purchases and keeps unchanged subscription references on entitlement changes', () => {
        const api = createTestStore();
        const customer: CustomerInfo = {
            activeSubscriptions: { subscription: {} },
            entitlements: { all: { voice: { identifier: 'voice', isActive: true } } },
            originalAppUserId: 'account-a',
            requestDate: new Date(0),
        };
        api.getState().applyPurchases(customer);
        const previous = api.getState();
        const notified = vi.fn();
        api.subscribe(notified);

        api.getState().applyPurchases(structuredClone(customer));
        expect(api.getState()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        api.getState().applyPurchases({ ...customer,
            entitlements: { all: { voice: { identifier: 'voice', isActive: false } } },
        });
        expect(api.getState().purchases.entitlements.voice).toBe(false);
        expect(api.getState().purchases.activeSubscriptions).toBe(previous.purchases.activeSubscriptions);
        expect(notified).toHaveBeenCalledTimes(1);
    });

    it('preserves equal local collections alongside a real setting change', () => {
        const api = createTestStore();
        api.getState().applyLocalSettings({ acknowledgedCliVersions: { 'machine-a': '1.2.3' } });
        const previous = api.getState();
        const notified = vi.fn();
        api.subscribe(notified);

        api.getState().applyLocalSettings({ acknowledgedCliVersions: { 'machine-a': '1.2.3' } });
        expect(api.getState()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        api.getState().applyLocalSettings({ acknowledgedCliVersions: { 'machine-a': '1.2.3' }, uiFontScale: 1.1 });
        expect(api.getState().localSettings.acknowledgedCliVersions).toBe(previous.localSettings.acknowledgedCliVersions);
        expect(api.getState().localSettings.uiFontScale).toBe(1.1);
        expect(notified).toHaveBeenCalledTimes(1);
    });

    it('keeps unchanged concurrent indexes when grouping changes leave their empty result unchanged', () => {
        const api = createTestStore();
        api.setState({
            ordinarySessionListMembershipByServerId: { 'server-other': [] },
            sessionListIndexByServerId: { 'server-other': [] },
        });
        const originalLayout = api.getState().settings.sessionListLayoutV1;
        api.getState().applySettingsLocal({ sessionListLayoutV1: originalLayout === 'projects' ? 'recent_activity' : 'projects' });
        const previousIndexes = api.getState().sessionListIndexByServerId;

        api.getState().applySettingsLocal({ sessionListLayoutV1: originalLayout });

        expect(api.getState().settings.sessionListLayoutV1).toBe(originalLayout);
        expect(api.getState().sessionListIndexByServerId).toBe(previousIndexes);
    });

    it('lands a genuine remote change while preserving references for the keys that did not change', async () => {
        const { getState } = createTestStore();
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const settingsBeforeEcho = getState().settings;
        const machinesBeforeEcho = settingsBeforeEcho.favoriteMachines;

        getState().applySettingsForScope(scope, buildServerEchoSettings({
            favoriteDirectories: ['~/code/happier', '~/code/other'],
        }), 2);

        expect(getState().settings).not.toBe(settingsBeforeEcho);
        expect(getState().settings.favoriteDirectories).toEqual(['~/code/happier', '~/code/other']);
        expect(getState().settings.favoriteMachines).toBe(machinesBeforeEcho);
        expect(loadAccountSettings(scope).settings).toMatchObject({
            favoriteDirectories: ['~/code/happier', '~/code/other'],
        });
    });

    it('lands a remote scalar change that arrives alongside otherwise identical settings', async () => {
        const { getState } = createTestStore();
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        getState().applySettingsForScope(scope, buildServerEchoSettings({ analyticsOptOut: true }), 2);

        expect(getState().settings.analyticsOptOut).toBe(true);
        expect(getState().settingsVersion).toBe(2);
    });

    it('reuses Actions policy on unchanged echoes and observes local and remote policy changes immediately', async () => {
        const { getState } = createTestStore();
        const context = { surface: 'ui', authority: 'present_user' } as const;
        const disabledPolicy = normalizeActionsSettingsV1({ v: 1, actions: {
            'session.stop': { enabled: false, approvalRequiredSurfaces: ['ui'] },
        } });
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings({ actionsSettingsV1: disabledPolicy }), 1);
        const initial = resolveActionsSettingsV1FromState(getState());

        getState().applySettingsForScope(scope, buildServerEchoSettings({ actionsSettingsV1: disabledPolicy, analyticsOptOut: true }), 2);
        expect(resolveActionsSettingsV1FromState(getState())).toBe(initial);
        expect(isActionEnabledInState(getState(), 'session.stop', context)).toBe(false);
        expect(isActionApprovalRequiredInState(getState(), 'session.stop', context)).toBe(true);

        getState().applySettingsLocal({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'session.stop': { enabled: true } }, approvalWaivedSurfaces: { 'session.stop': ['ui'] },
        }) });
        expect(isActionEnabledInState(getState(), 'session.stop', context)).toBe(true);
        expect(isActionApprovalRequiredInState(getState(), 'session.stop', context)).toBe(false);
        expect(resolveActionsSettingsV1FromState(getState())).not.toBe(initial);

        getState().applySettingsForScope(scope, buildServerEchoSettings({ actionsSettingsV1: disabledPolicy }), 3);
        expect(isActionEnabledInState(getState(), 'session.stop', context)).toBe(false);
        expect(isActionApprovalRequiredInState(getState(), 'session.stop', context)).toBe(true);
    });

    it('still applies a local write that changes a nested collection', async () => {
        const { getState } = createTestStore();
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const settingsBeforeLocalWrite = getState().settings;

        getState().applySettingsLocal({ favoriteDirectories: ['~/code/happier', '~/code/other'] });

        expect(getState().settings).not.toBe(settingsBeforeLocalWrite);
        expect(getState().settings.favoriteDirectories).toEqual(['~/code/happier', '~/code/other']);
        expect(getState().settings.favoriteMachines).toBe(settingsBeforeLocalWrite.favoriteMachines);
    });

    it('does not resurrect a previous value when a local write re-sets an equal collection', async () => {
        const { getState } = createTestStore();
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const favoritesBeforeLocalWrite = getState().settings.favoriteDirectories;

        getState().applySettingsLocal({ favoriteDirectories: ['~/code/happier'] });

        expect(getState().settings.favoriteDirectories).toEqual(['~/code/happier']);
        expect(getState().settings.favoriteDirectories).toBe(favoritesBeforeLocalWrite);
    });

    it('restores device Administration memory only for their exact Account and Home', async () => {
        const { getState } = createTestStore();
        const targets = { agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' } };
        await getState().activateSettingsScope(scope);
        getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: targets });

        for (const otherScope of [
            { ...scope, accountId: 'account-b' },
            { ...scope, serverId: 'server-b' },
        ]) {
            await getState().activateSettingsScope(otherScope);
            expect(getState().settings.machineAdministrationTargetsLocalV1).toEqual({});
        }
        await getState().activateSettingsScope(scope);
        expect(getState().settings.machineAdministrationTargetsLocalV1).toEqual(targets);
    });
});
