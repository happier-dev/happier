import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
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
    sessionListRenderables: {};
    machines: {};
    machineDisplayById: {};
    sessionListViewData: null;
    sessionListViewDataByServerId: {};
}>;

function createTestStore(): { getState: () => TestState } {
    let state = {
        sessions: {},
        sessionListRenderables: {},
        machines: {},
        machineDisplayById: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
    } as TestState;

    const set = (updater: ((state: TestState) => Partial<TestState> | TestState) | Partial<TestState>) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    const get = () => state;
    const domain = createSettingsDomain<TestState>({ set, get });
    state = { ...state, ...(domain as SettingsDomainApi) };

    return { getState: () => state };
}

/**
 * A settings echo from the server is re-parsed from scratch (`settingsParse` + secret sealing),
 * so every object/array-valued key arrives as a fresh reference even when nothing changed.
 * These tests pin the projection contract: identical content must not churn references,
 * and a genuine remote change must still land.
 */
function buildServerEchoSettings(overrides: Partial<Settings> = {}): Settings {
    return {
        ...structuredClone(settingsDefaults),
        serverSelectionGroups: [
            { id: 'grp-dev', name: 'Dev', serverIds: ['server-a'], presentation: 'grouped' },
        ],
        favoriteDirectories: ['~/code/happier'],
        ...structuredClone(overrides),
    } as Settings;
}

describe('createSettingsDomain settings projection reference stability', () => {
    const scope: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-a' };

    beforeEach(() => {
        clearPersistence();
        store.clear();
    });

    it('keeps the settings projection reference when a server echo carries structurally identical settings', () => {
        const { getState } = createTestStore();
        getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const settingsBeforeEcho = getState().settings;
        const groupsBeforeEcho = settingsBeforeEcho.serverSelectionGroups;

        getState().applySettingsForScope(scope, buildServerEchoSettings(), 2);

        expect(getState().settings).toBe(settingsBeforeEcho);
        expect(getState().settings.serverSelectionGroups).toBe(groupsBeforeEcho);
        expect(getState().settingsVersion).toBe(2);
        expect(loadAccountSettings(scope).version).toBe(2);
    });

    it('lands a genuine remote change while preserving references for the keys that did not change', () => {
        const { getState } = createTestStore();
        getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const settingsBeforeEcho = getState().settings;
        const favoritesBeforeEcho = settingsBeforeEcho.favoriteDirectories;

        getState().applySettingsForScope(scope, buildServerEchoSettings({
            serverSelectionGroups: [
                { id: 'grp-dev', name: 'Dev renamed', serverIds: ['server-a'], presentation: 'grouped' },
            ],
        }), 2);

        expect(getState().settings).not.toBe(settingsBeforeEcho);
        expect(getState().settings.serverSelectionGroups).toEqual([
            { id: 'grp-dev', name: 'Dev renamed', serverIds: ['server-a'], presentation: 'grouped' },
        ]);
        expect(getState().settings.favoriteDirectories).toBe(favoritesBeforeEcho);
        expect(loadAccountSettings(scope).settings).toMatchObject({
            serverSelectionGroups: [expect.objectContaining({ name: 'Dev renamed' })],
        });
    });

    it('lands a remote scalar change that arrives alongside otherwise identical settings', () => {
        const { getState } = createTestStore();
        getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        getState().applySettingsForScope(scope, buildServerEchoSettings({ analyticsOptOut: true }), 2);

        expect(getState().settings.analyticsOptOut).toBe(true);
        expect(getState().settingsVersion).toBe(2);
    });

    it('keeps a replace projection reference-stable for identical content while still advancing the version', () => {
        const { getState } = createTestStore();
        getState().activateSettingsScope(scope);
        getState().replaceSettingsForScope(scope, buildServerEchoSettings(), 5);

        const settingsBeforeReplace = getState().settings;

        getState().replaceSettingsForScope(scope, buildServerEchoSettings(), 3);

        expect(getState().settings).toBe(settingsBeforeReplace);
        expect(getState().settingsVersion).toBe(3);
    });

    it('still applies a local write that changes a nested collection', () => {
        const { getState } = createTestStore();
        getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const settingsBeforeLocalWrite = getState().settings;

        getState().applySettingsLocal({ favoriteDirectories: ['~/code/happier', '~/code/other'] });

        expect(getState().settings).not.toBe(settingsBeforeLocalWrite);
        expect(getState().settings.favoriteDirectories).toEqual(['~/code/happier', '~/code/other']);
        expect(getState().settings.serverSelectionGroups).toBe(settingsBeforeLocalWrite.serverSelectionGroups);
    });

    it('does not resurrect a previous value when a local write re-sets an equal collection', () => {
        const { getState } = createTestStore();
        getState().activateSettingsScope(scope);
        getState().applySettingsForScope(scope, buildServerEchoSettings(), 1);

        const favoritesBeforeLocalWrite = getState().settings.favoriteDirectories;

        getState().applySettingsLocal({ favoriteDirectories: ['~/code/happier'] });

        expect(getState().settings.favoriteDirectories).toEqual(['~/code/happier']);
        expect(getState().settings.favoriteDirectories).toBe(favoritesBeforeLocalWrite);
    });
});
