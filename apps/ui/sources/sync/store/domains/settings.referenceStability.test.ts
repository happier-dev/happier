import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { getPreferredLanguage, setPreferredLanguageFromSettings, t } from '@/text/i18n';
import { es } from '@/text/translations/es';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { clearPersistence } from '@/sync/domains/state/persistence';
import { createInitialSessionSplitCanvasSnapshot } from '@/sync/domains/session/sessionSplitCanvasPersistence';

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
        const { getState } = createTestStore();
        await getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const settingsBeforeEcho = getState().settings;
        const favoritesBeforeEcho = settingsBeforeEcho.favoriteDirectories;

        getState().applySettingsForScope(scope, buildServerEchoSettings(), 2);

        expect(getState().settings).toBe(settingsBeforeEcho);
        expect(getState().settings.favoriteDirectories).toBe(favoritesBeforeEcho);
        expect(getState().settingsVersion).toBe(2);
        expect(loadAccountSettings(scope).version).toBe(2);
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

    it('restores device layout and Administration memory only for their exact Account and Home', async () => {
        const { getState } = createTestStore();
        const targets = { agents: { serverIdentityId: 'srv_one', machineId: 'machine-a' } };
        const layouts = { workspace: createInitialSessionSplitCanvasSnapshot({ sessionId: 'session-a', scope }) };
        await getState().activateSettingsScope(scope);
        getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: targets, sessionSplitCanvasLayoutsV1: layouts });

        for (const otherScope of [
            { ...scope, accountId: 'account-b' },
            { ...scope, serverId: 'server-b' },
        ]) {
            await getState().activateSettingsScope(otherScope);
            expect(getState().settings.machineAdministrationTargetsLocalV1).toEqual({});
            expect(getState().settings.sessionSplitCanvasLayoutsV1).toEqual({});
        }
        await getState().activateSettingsScope(scope);
        expect(getState().settings.machineAdministrationTargetsLocalV1).toEqual(targets);
        expect(getState().settings.sessionSplitCanvasLayoutsV1).toEqual(layouts);
    });
});
