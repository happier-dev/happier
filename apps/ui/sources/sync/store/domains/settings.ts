import type { CustomerInfo } from '../../revenueCat/types';
import type { Machine, Session } from '../../storageTypes';
import type { SessionListViewItem } from '../../sessionListViewData';
import { applyLocalSettings, type LocalSettings } from '../../localSettings';
import { customerInfoToPurchases, type Purchases } from '../../purchases';
import { applySettings, type Settings } from '../../settings';
import { loadLocalSettings, loadPurchases, loadSettings, saveLocalSettings, savePurchases, saveSettings } from '../../persistence';
import { buildSessionListViewDataWithServerScope } from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';

import type { StoreGet, StoreSet } from './_shared';

export type SettingsDomain = {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    applySettingsLocal: (delta: Partial<Settings>) => void;
    applySettings: (settings: Settings, version: number) => void;
    replaceSettings: (settings: Settings, version: number) => void;
    applyLocalSettings: (delta: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
};

type SettingsDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    machines: Record<string, Machine>;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
}>;

export function createSettingsDomain<S extends SettingsDomain & SettingsDomainDependencies>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SettingsDomain {
    const { settings, version } = loadSettings();
    const localSettings = loadLocalSettings();
    const purchases = loadPurchases();

    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        applySettingsLocal: (delta) =>
            set((state) => {
                const newSettings = applySettings(state.settings, delta);
                saveSettings(newSettings, state.settingsVersion ?? 0);

                const shouldRebuildSessionListViewData =
                    Object.prototype.hasOwnProperty.call(delta, 'groupInactiveSessionsByProject') &&
                    delta.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject;

                if (shouldRebuildSessionListViewData) {
                    const sessionListViewData = buildSessionListViewDataWithServerScope({
                        sessions: state.sessions,
                        machines: state.machines,
                        groupInactiveSessionsByProject: newSettings.groupInactiveSessionsByProject,
                    });
                    return {
                        ...state,
                        settings: newSettings,
                        sessionListViewData,
                        sessionListViewDataByServerId: setActiveServerSessionListCache(
                            state.sessionListViewDataByServerId,
                            sessionListViewData,
                        ),
                    };
                }
                return {
                    ...state,
                    settings: newSettings,
                };
            }),
        applySettings: (nextSettings, nextVersion) =>
            set((state) => {
                if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                    saveSettings(nextSettings, nextVersion);

                    const shouldRebuildSessionListViewData =
                        nextSettings.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject;

                    const sessionListViewData = shouldRebuildSessionListViewData
                        ? buildSessionListViewDataWithServerScope({
                            sessions: state.sessions,
                            machines: state.machines,
                            groupInactiveSessionsByProject: nextSettings.groupInactiveSessionsByProject,
                        })
                        : state.sessionListViewData;

                    return {
                        ...state,
                        settings: nextSettings,
                        settingsVersion: nextVersion,
                        sessionListViewData,
                        sessionListViewDataByServerId: shouldRebuildSessionListViewData
                            ? setActiveServerSessionListCache(state.sessionListViewDataByServerId, sessionListViewData)
                            : state.sessionListViewDataByServerId,
                    };
                }
                return state;
            }),
        replaceSettings: (nextSettings, nextVersion) =>
            set((state) => {
                saveSettings(nextSettings, nextVersion);

                const shouldRebuildSessionListViewData =
                    nextSettings.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject;

                const sessionListViewData = shouldRebuildSessionListViewData
                    ? buildSessionListViewDataWithServerScope({
                        sessions: state.sessions,
                        machines: state.machines,
                        groupInactiveSessionsByProject: nextSettings.groupInactiveSessionsByProject,
                    })
                    : state.sessionListViewData;

                return {
                    ...state,
                    settings: nextSettings,
                    settingsVersion: nextVersion,
                    sessionListViewData,
                    sessionListViewDataByServerId: shouldRebuildSessionListViewData
                        ? setActiveServerSessionListCache(state.sessionListViewDataByServerId, sessionListViewData)
                        : state.sessionListViewDataByServerId,
                };
            }),
        applyLocalSettings: (delta) =>
            set((state) => {
                const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
                saveLocalSettings(updatedLocalSettings);
                return {
                    ...state,
                    localSettings: updatedLocalSettings,
                };
            }),
        applyPurchases: (customerInfo) =>
            set((state) => {
                const nextPurchases = customerInfoToPurchases(customerInfo);
                savePurchases(nextPurchases);
                return {
                    ...state,
                    purchases: nextPurchases,
                };
            }),
    };
}
