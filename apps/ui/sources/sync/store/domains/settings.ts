import type { CustomerInfo } from '../../domains/purchases/types';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '../../domains/state/storageTypes';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { ServerScopedSessionListCache } from '../../domains/session/listing/serverScopedSessionListCache';
import { applyLocalSettings, type LocalSettings } from '../../domains/settings/localSettings';
import { customerInfoToPurchases, type Purchases } from '../../domains/purchases/purchases';
import { applySettings, settingsParse, type Settings } from '../../domains/settings/settings';
import { loadLocalSettings, loadPurchases, loadSettings, saveLocalSettings, savePurchases, saveSettings } from '../../domains/state/persistence';
import { resolveActiveServerSessionListState } from '../resolveActiveServerSessionListState';
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
    localSettings: LocalSettings;
    purchases: Purchases;
    applySettingsLocal: (delta: Partial<Settings>) => void;
    applySettings: (settings: Settings, version: number) => void;
    replaceSettings: (settings: Settings, version: number) => void;
    applyLocalSettings: (delta: Partial<LocalSettings>, options?: { source?: SettingsAnalyticsSource }) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
};

type SettingsDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: ServerScopedSessionListCache;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; rootPath?: string | null } | null } | null;
}>;

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
        localSettings,
        purchases,
        applySettingsLocal: (delta) =>
            set((state) => {
                const newSettings = applySettings(state.settings, delta);
                saveSettings(newSettings, state.settingsVersion ?? 0);

                const shouldRebuildSessionListViewData =
                    (Object.prototype.hasOwnProperty.call(delta, 'groupInactiveSessionsByProject') &&
                        delta.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject) ||
                    (Object.prototype.hasOwnProperty.call(delta, 'sessionListActiveGroupingV1') &&
                        delta.sessionListActiveGroupingV1 !== state.settings.sessionListActiveGroupingV1) ||
                    (Object.prototype.hasOwnProperty.call(delta, 'sessionListInactiveGroupingV1') &&
                        delta.sessionListInactiveGroupingV1 !== state.settings.sessionListInactiveGroupingV1);

                if (shouldRebuildSessionListViewData) {
                    const rebuiltListState = resolveActiveServerSessionListState({
                        state: {
                            ...state,
                            settings: newSettings,
                        },
                        shouldRebuild: true,
                    });
                    safeSetPreferredLanguageFromSettings(newSettings.preferredLanguage);
                    return {
                        ...state,
                        settings: newSettings,
                        sessionListViewData: rebuiltListState.sessionListViewData,
                    };
                }
                safeSetPreferredLanguageFromSettings(newSettings.preferredLanguage);
                return {
                    ...state,
                    settings: newSettings,
                };
            }),
        applySettings: (nextSettings, nextVersion) =>
            set((state) => {
                if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                    saveSettings(nextSettings, nextVersion);
                    safeSetPreferredLanguageFromSettings(nextSettings.preferredLanguage);

                    const shouldRebuildSessionListViewData =
                        nextSettings.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject ||
                        nextSettings.sessionListActiveGroupingV1 !== state.settings.sessionListActiveGroupingV1 ||
                        nextSettings.sessionListInactiveGroupingV1 !== state.settings.sessionListInactiveGroupingV1;

                    const rebuiltListState = resolveActiveServerSessionListState({
                        state: {
                            ...state,
                            settings: nextSettings,
                        },
                        shouldRebuild: shouldRebuildSessionListViewData,
                    });

                    return {
                        ...state,
                        settings: nextSettings,
                        settingsVersion: nextVersion,
                        sessionListViewData: rebuiltListState.sessionListViewData,
                    };
                }
                return state;
            }),
        replaceSettings: (nextSettings, nextVersion) =>
            set((state) => {
                saveSettings(nextSettings, nextVersion);
                safeSetPreferredLanguageFromSettings(nextSettings.preferredLanguage);

                const shouldRebuildSessionListViewData =
                    nextSettings.groupInactiveSessionsByProject !== state.settings.groupInactiveSessionsByProject ||
                    nextSettings.sessionListActiveGroupingV1 !== state.settings.sessionListActiveGroupingV1 ||
                    nextSettings.sessionListInactiveGroupingV1 !== state.settings.sessionListInactiveGroupingV1;

                const rebuiltListState = resolveActiveServerSessionListState({
                    state: {
                        ...state,
                        settings: nextSettings,
                    },
                    shouldRebuild: shouldRebuildSessionListViewData,
                });

                return {
                    ...state,
                    settings: nextSettings,
                    settingsVersion: nextVersion,
                    sessionListViewData: rebuiltListState.sessionListViewData,
                };
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
                savePurchases(nextPurchases);
                return {
                    ...state,
                    purchases: nextPurchases,
                };
            }),
    };
}
