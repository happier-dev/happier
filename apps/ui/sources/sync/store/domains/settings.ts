import type { CustomerInfo } from '../../domains/purchases/types';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '../../domains/state/storageTypes';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { applyLocalSettings, type LocalSettings } from '../../domains/settings/localSettings';
import { customerInfoToPurchases, type Purchases } from '../../domains/purchases/purchases';
import { applySettings, settingsParse, type Settings } from '../../domains/settings/settings';
import { loadLocalSettings, loadPurchases, loadSettings, saveLocalSettings, savePurchases, saveSettings } from '../../domains/state/persistence';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import type { ConcurrentSessionListCacheByServerId } from '../../domains/session/listing/concurrentSessionListCache';
import {
    buildActiveServerSessionListIndex,
    buildMachineDisplaysByIdFromMachineList,
    buildSessionListIndexWithServerScope,
} from '../sessionListIndex/buildSessionListIndexWithServerScope';
import { resolveSessionListIndexSettingsImpact } from './settingsSessionListIndexImpact';
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
    machineListByServerId: Record<string, Machine[] | null>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; rootPath?: string | null } | null } | null;
}>;

type SettingsDomainState = SettingsDomain & SettingsDomainDependencies;

function rebuildSessionListIndexesForSettingsChange(
    state: SettingsDomainState,
    nextSettings: Settings,
): Readonly<Record<string, SessionListIndexItem[] | null | undefined>> {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    let nextSessionListIndexByServerId = state.sessionListIndexByServerId ?? {};

    if (activeServerId) {
        const previousActiveIndex = nextSessionListIndexByServerId[activeServerId] ?? null;
        const nextActiveIndex = buildActiveServerSessionListIndex({
            sessions: state.sessionListRenderables,
            sessionRecords: state.sessions,
            machines: state.machineDisplayById,
            machineRecords: state.machines,
            groupInactiveSessionsByProject: nextSettings.groupInactiveSessionsByProject === true,
            activeGroupingV1: nextSettings.sessionListActiveGroupingV1,
            inactiveGroupingV1: nextSettings.sessionListInactiveGroupingV1,
            getProjectForSession: state.getProjectForSession,
            previousIndex: previousActiveIndex,
        });
        if (nextSessionListIndexByServerId[activeServerId] !== nextActiveIndex) {
            nextSessionListIndexByServerId = { ...nextSessionListIndexByServerId, [activeServerId]: nextActiveIndex };
        }
    }

    const concurrent = state.concurrentSessionListCacheByServerId ?? {};
    let didUpdateConcurrent = false;
    const concurrentUpdates: Record<string, SessionListIndexItem[] | null> = {};
    for (const serverId in concurrent) {
        const entry = concurrent[serverId];
        if (!entry || typeof entry !== 'object') continue;
        if (!entry.sessions || typeof entry.sessions !== 'object') continue;
        concurrentUpdates[serverId] = buildSessionListIndexWithServerScope({
            sessions: entry.sessions,
            machines: buildMachineDisplaysByIdFromMachineList(state.machineListByServerId?.[serverId]),
            groupInactiveSessionsByProject: nextSettings.groupInactiveSessionsByProject === true,
            activeGroupingV1: nextSettings.sessionListActiveGroupingV1,
            inactiveGroupingV1: nextSettings.sessionListInactiveGroupingV1,
            serverScope: {
                serverId,
                serverName: entry.serverName ?? undefined,
            },
            previousIndex: nextSessionListIndexByServerId[serverId] ?? null,
        });
        didUpdateConcurrent = true;
    }

    if (!didUpdateConcurrent) {
        return nextSessionListIndexByServerId;
    }

    return { ...nextSessionListIndexByServerId, ...concurrentUpdates };
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
        localSettings,
        purchases,
        applySettingsLocal: (delta) =>
            set((state) => {
                const newSettings = applySettings(state.settings, delta);
                saveSettings(newSettings, state.settingsVersion ?? 0);
                const shouldRebuildSessionListIndex = resolveSessionListIndexSettingsImpact(
                    state.settings,
                    newSettings,
                );

                safeSetPreferredLanguageFromSettings(newSettings.preferredLanguage);
                const nextSessionListIndexByServerId = shouldRebuildSessionListIndex
                    ? rebuildSessionListIndexesForSettingsChange(state, newSettings)
                    : (state.sessionListIndexByServerId ?? {});
                return {
                    ...state,
                    settings: newSettings,
                    sessionListIndexByServerId: nextSessionListIndexByServerId,
                };
            }),
        applySettings: (nextSettings, nextVersion) =>
            set((state) => {
                if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                    saveSettings(nextSettings, nextVersion);
                    safeSetPreferredLanguageFromSettings(nextSettings.preferredLanguage);
                    const shouldRebuildSessionListIndex = resolveSessionListIndexSettingsImpact(
                        state.settings,
                        nextSettings,
                    );
                    const nextSessionListIndexByServerId = shouldRebuildSessionListIndex
                        ? rebuildSessionListIndexesForSettingsChange(state, nextSettings)
                        : (state.sessionListIndexByServerId ?? {});
                    return {
                        ...state,
                        settings: nextSettings,
                        settingsVersion: nextVersion,
                        sessionListIndexByServerId: nextSessionListIndexByServerId,
                    };
                }
                return state;
            }),
        replaceSettings: (nextSettings, nextVersion) =>
            set((state) => {
                saveSettings(nextSettings, nextVersion);
                safeSetPreferredLanguageFromSettings(nextSettings.preferredLanguage);
                const shouldRebuildSessionListIndex = resolveSessionListIndexSettingsImpact(
                    state.settings,
                    nextSettings,
                );
                const nextSessionListIndexByServerId = shouldRebuildSessionListIndex
                    ? rebuildSessionListIndexesForSettingsChange(state, nextSettings)
                    : (state.sessionListIndexByServerId ?? {});
                return {
                    ...state,
                    settings: nextSettings,
                    settingsVersion: nextVersion,
                    sessionListIndexByServerId: nextSessionListIndexByServerId,
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
