import type { CustomerInfo } from '../../domains/purchases/types';
import type { Machine, Session } from '../../domains/state/storageTypes';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import { applyLocalSettings, type LocalSettings } from '../../domains/settings/localSettings';
import { customerInfoToPurchases, purchasesDefaults, type Purchases } from '../../domains/purchases/purchases';
import { applySettings, settingsDefaults, settingsParse, type Settings } from '../../domains/settings/settings';
import {
    loadAccountSettings,
    prepareAccountSettingsScopeForActivation,
    saveAccountSettings,
} from '../../domains/state/accountSettingsPersistence';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '../../domains/settings/scope/accountSettingsScope';
import {
    loadAccountPurchases,
    prepareAccountProfileScopeForActivation,
    saveAccountPurchases,
} from '../../domains/state/accountProfilePersistence';
import { loadLocalSettings, loadPurchases, loadSettings, saveLocalSettings, savePurchases, saveSettings } from '../../domains/state/persistence';
import { buildSessionListViewDataWithServerScope } from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';
import { emitLocalSettingChangedEvents } from '@/track/settingsAnalytics/emitSettingChangedEvent';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { setPreferredLanguageFromSettings } from '@/text/i18n';

import type { StoreGet, StoreSet } from './_shared';

function safeSetPreferredLanguageFromSettings(preferredLanguage: unknown): void {
    try {
        setPreferredLanguageFromSettings(preferredLanguage as any);
    } catch {
        // In Vitest/Vite SSR, circular module initialization can surface as TDZ errors on imports.
        // Preferred-language sync is best-effort and should never crash store initialization.
    }
}

export type SettingsDomain = {
    settings: Settings;
    settingsVersion: number | null;
    settingsScope: AccountSettingsScope | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    applySettingsLocal: (delta: Partial<Settings>) => void;
    applySettings: (settings: Settings, version: number) => void;
    replaceSettings: (settings: Settings, version: number) => void;
    activateSettingsScope: (scope: AccountSettingsScope) => void;
    clearSettingsScope: () => void;
    applySettingsForScope: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    replaceSettingsForScope: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    applyLocalSettings: (delta: Partial<LocalSettings>, options?: { source?: SettingsAnalyticsSource }) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
};

type SettingsDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; path?: string | null } | null } | null;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
}>;

function shouldRebuildSessionListViewData(previous: Settings, next: Settings): boolean {
    return next.groupInactiveSessionsByProject !== previous.groupInactiveSessionsByProject ||
        next.sessionListActiveGroupingV1 !== previous.sessionListActiveGroupingV1 ||
        next.sessionListInactiveGroupingV1 !== previous.sessionListInactiveGroupingV1;
}

function buildSettingsProjectionState<S extends SettingsDomain & SettingsDomainDependencies>(
    state: S,
    nextSettings: Settings,
    nextVersion: number | null,
    nextScope: AccountSettingsScope | null,
): S {
    safeSetPreferredLanguageFromSettings(nextSettings.preferredLanguage);

    const shouldRebuildSessionListViewDataValue = shouldRebuildSessionListViewData(state.settings, nextSettings);
    const sessionListViewData = shouldRebuildSessionListViewDataValue
        ? buildSessionListViewDataWithServerScope({
            sessions: state.sessionListRenderables,
            sessionRecords: state.sessions,
            machines: state.machineDisplayById,
            machineRecords: state.machines,
            groupInactiveSessionsByProject: nextSettings.groupInactiveSessionsByProject,
            activeGroupingV1: nextSettings.sessionListActiveGroupingV1,
            inactiveGroupingV1: nextSettings.sessionListInactiveGroupingV1,
            getProjectForSession: state.getProjectForSession,
        })
        : state.sessionListViewData;

    return {
        ...state,
        settings: nextSettings,
        settingsVersion: nextVersion,
        settingsScope: nextScope,
        sessionListViewData,
        sessionListViewDataByServerId: shouldRebuildSessionListViewDataValue
            ? setActiveServerSessionListCache(state.sessionListViewDataByServerId, sessionListViewData)
            : state.sessionListViewDataByServerId,
    };
}

function loadParsedAccountSettings(scope: AccountSettingsScope): { settings: Settings; version: number | null } {
    const loaded = loadAccountSettings(scope);
    return {
        settings: settingsParse(loaded.settings),
        version: loaded.version,
    };
}

function shouldAcceptScopedSettings(scope: AccountSettingsScope, nextVersion: number): boolean {
    const loaded = loadAccountSettings(scope);
    return loaded.version == null || loaded.version < nextVersion;
}

export function createSettingsDomain<S extends SettingsDomain & SettingsDomainDependencies>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SettingsDomain {
    const { settings: rawSettings, version } = loadSettings();
    const settings = settingsParse(rawSettings);
    safeSetPreferredLanguageFromSettings(settings.preferredLanguage);
    const localSettings = loadLocalSettings();
    const purchases = loadPurchases();

    return {
        settings,
        settingsVersion: version,
        settingsScope: null,
        localSettings,
        purchases,
        applySettingsLocal: (delta) =>
            set((state) => {
                const newSettings = applySettings(state.settings, delta);
                if (state.settingsScope) {
                    saveAccountSettings(state.settingsScope, newSettings, state.settingsVersion ?? 0);
                } else {
                    saveSettings(newSettings, state.settingsVersion ?? 0);
                }

                return buildSettingsProjectionState(state, newSettings, state.settingsVersion, state.settingsScope);
            }),
        applySettings: (nextSettings, nextVersion) =>
            set((state) => {
                if (state.settingsScope) {
                    if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                        saveAccountSettings(state.settingsScope, nextSettings, nextVersion);
                        return buildSettingsProjectionState(state, nextSettings, nextVersion, state.settingsScope);
                    }
                    return state;
                }
                if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                    saveSettings(nextSettings, nextVersion);
                    return buildSettingsProjectionState(state, nextSettings, nextVersion, null);
                }
                return state;
            }),
        replaceSettings: (nextSettings, nextVersion) =>
            set((state) => {
                if (state.settingsScope) {
                    saveAccountSettings(state.settingsScope, nextSettings, nextVersion);
                    return buildSettingsProjectionState(state, nextSettings, nextVersion, state.settingsScope);
                }
                saveSettings(nextSettings, nextVersion);
                return buildSettingsProjectionState(state, nextSettings, nextVersion, null);
            }),
        activateSettingsScope: (scope) =>
            set((state) => {
                prepareAccountSettingsScopeForActivation(scope);
                prepareAccountProfileScopeForActivation(scope);
                const loaded = loadParsedAccountSettings(scope);
                return {
                    ...buildSettingsProjectionState(state, loaded.settings, loaded.version, scope),
                    purchases: loadAccountPurchases(scope),
                };
            }),
        clearSettingsScope: () =>
            set((state) => ({
                ...buildSettingsProjectionState(state, { ...settingsDefaults }, null, null),
                purchases: { ...purchasesDefaults },
            })),
        applySettingsForScope: (scope, nextSettings, nextVersion) =>
            set((state) => {
                if (!shouldAcceptScopedSettings(scope, nextVersion)) {
                    return state;
                }
                saveAccountSettings(scope, nextSettings, nextVersion);
                if (!areAccountSettingsScopesEqual(state.settingsScope, scope)) {
                    return state;
                }
                return buildSettingsProjectionState(state, nextSettings, nextVersion, scope);
            }),
        replaceSettingsForScope: (scope, nextSettings, nextVersion) =>
            set((state) => {
                saveAccountSettings(scope, nextSettings, nextVersion);
                if (!areAccountSettingsScopesEqual(state.settingsScope, scope)) {
                    return state;
                }
                return buildSettingsProjectionState(state, nextSettings, nextVersion, scope);
            }),
        applyLocalSettings: (delta, options) =>
            set((state) => {
                const previousLocalSettings = state.localSettings;
                const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
                saveLocalSettings(updatedLocalSettings);
                emitLocalSettingChangedEvents({
                    previousSettings: previousLocalSettings,
                    nextSettings: updatedLocalSettings,
                    source: options?.source,
                });
                return {
                    ...state,
                    localSettings: updatedLocalSettings,
                };
            }),
        applyPurchases: (customerInfo) =>
            set((state) => {
                const nextPurchases = customerInfoToPurchases(customerInfo);
                if (state.settingsScope) {
                    saveAccountPurchases(state.settingsScope, nextPurchases);
                } else {
                    savePurchases(nextPurchases);
                }
                return {
                    ...state,
                    purchases: nextPurchases,
                };
            }),
    };
}
