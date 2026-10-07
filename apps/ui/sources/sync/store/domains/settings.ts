import type { CustomerInfo } from '../../domains/purchases/types';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '../../domains/state/storageTypes';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
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
import { areAccountSettingsJsonValuesEqual } from '../../domains/settings/accountSettingsStructuralEquality';
import { reconcileSettingsReferences } from '../../domains/settings/reconcileSettingsReferences';
import {
    loadAccountPurchases,
    prepareAccountProfileScopeForActivation,
    saveAccountPurchases,
} from '../../domains/state/accountProfilePersistence';
import { loadLocalSettings, loadPurchases, loadSettings, saveLocalSettings, savePurchases, saveSettings } from '../../domains/state/settingsPersistence';
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
import { areTranslationsReadyForSettings, getPreferredLanguage, preloadTranslationsForSettings, setPreferredLanguageFromSettings } from '@/text/i18n';
import { loadHomeViewState } from '@/sync/domains/server/serverProfiles';
import { normalizeServerSelectionGroupsForSettings } from '@/sync/domains/server/selection/serverSelectionSettingsAdapter';

import type { StoreGet, StoreSet } from './_shared';

function safeSetPreferredLanguageFromSettings(preferredLanguage: unknown): void {
    try {
        setPreferredLanguageFromSettings(preferredLanguage);
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
    activateSettingsScope: (scope: AccountSettingsScope, legacyScopes?: readonly AccountSettingsScope[]) => Promise<void>;
    clearSettingsScope: () => void;
    applySettingsForScope: (scope: AccountSettingsScope, settings: Settings, version: number) => void;
    /**
     * `persist: false` applies a runtime-only value (the embed's text scale): the store changes, the
     * device's saved local settings and their change events do not.
     */
    applyLocalSettings: (delta: Partial<LocalSettings>, options?: { source?: SettingsAnalyticsSource; persist?: boolean }) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
};

type SettingsDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    machineListByServerId: Record<string, Machine[] | null>;
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    ordinarySessionListMembershipByServerId?: Readonly<Record<string, readonly string[] | undefined>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; rootPath?: string | null } | null } | null;
}>;

type SettingsDomainState = SettingsDomain & SettingsDomainDependencies;

function readOrdinaryRowsForServer(
    state: SettingsDomainState,
    serverId: string,
): Readonly<Record<string, SessionListRenderableSession>> {
    const rows = state.sessionListRowsByServerId?.[serverId] ?? {};
    const membership = state.ordinarySessionListMembershipByServerId?.[serverId] ?? [];
    return Object.fromEntries(membership.flatMap((sessionId) => {
        const row = rows[sessionId];
        return row ? [[sessionId, row] as const] : [];
    }));
}

function rebuildSessionListIndexesForSettingsChange(
    state: SettingsDomainState,
    nextSettings: Settings,
): Readonly<Record<string, SessionListIndexItem[] | null | undefined>> {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    let nextSessionListIndexByServerId = state.sessionListIndexByServerId ?? {};

    if (activeServerId) {
        const previousActiveIndex = nextSessionListIndexByServerId[activeServerId] ?? null;
        const nextActiveIndex = buildActiveServerSessionListIndex({
            sessions: readOrdinaryRowsForServer(state, activeServerId),
            sessionRecords: state.sessions,
            machines: state.machineDisplayById,
            machineRecords: state.machines,
            activeGroupingV1: nextSettings.sessionListActiveGroupingV1,
            inactiveGroupingV1: nextSettings.sessionListInactiveGroupingV1,
            sectionModeV1: nextSettings.sessionListSectionModeV1,
            getProjectForSession: state.getProjectForSession,
            previousIndex: previousActiveIndex,
        });
        if (nextSessionListIndexByServerId[activeServerId] !== nextActiveIndex) {
            nextSessionListIndexByServerId = { ...nextSessionListIndexByServerId, [activeServerId]: nextActiveIndex };
        }
    }

    let didUpdateConcurrent = false;
    const concurrentUpdates: Record<string, SessionListIndexItem[] | null> = {};
    for (const serverId in state.ordinarySessionListMembershipByServerId ?? {}) {
        if (serverId === activeServerId) continue;
        const entry = state.concurrentSessionListCacheByServerId?.[serverId];
        concurrentUpdates[serverId] = buildSessionListIndexWithServerScope({
            sessions: readOrdinaryRowsForServer(state, serverId),
            machines: buildMachineDisplaysByIdFromMachineList(state.machineListByServerId?.[serverId]),
            activeGroupingV1: nextSettings.sessionListActiveGroupingV1,
            inactiveGroupingV1: nextSettings.sessionListInactiveGroupingV1,
            sectionModeV1: nextSettings.sessionListSectionModeV1,
            serverScope: {
                serverId,
                serverName: entry?.serverName ?? undefined,
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

function buildSettingsProjectionState<S extends SettingsDomain & SettingsDomainDependencies>(
    state: S,
    incomingSettings: Settings,
    nextVersion: number | null,
    nextScope: AccountSettingsScope | null,
): S {
    // Single seam for every settings writer. A server echo re-parses the whole settings document,
    // so every object/array-valued key arrives as a fresh reference even when nothing changed;
    // `useSettings`/`useSetting` subscribe shallowly and would re-render app-wide on that echo.
    // Content always wins — a key is reused only when structurally deep-equal to the previous one.
    const homeViewState = loadHomeViewState();
    const projectedSettings = homeViewState
        ? {
            ...incomingSettings,
            serverSelectionGroups: normalizeServerSelectionGroupsForSettings(homeViewState.groups),
            serverSelectionActiveTargetKind: homeViewState.activeTargetKind,
            serverSelectionActiveTargetId: homeViewState.activeTargetId,
        }
        : incomingSettings;
    const nextSettings = reconcileSettingsReferences(state.settings, projectedSettings);

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
        settingsScope: nextScope,
        sessionListIndexByServerId: nextSessionListIndexByServerId,
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
    const parsedSettings = settingsParse(rawSettings);
    const homeViewState = loadHomeViewState();
    const settings = homeViewState
        ? {
            ...parsedSettings,
            serverSelectionGroups: normalizeServerSelectionGroupsForSettings(homeViewState.groups),
            serverSelectionActiveTargetKind: homeViewState.activeTargetKind,
            serverSelectionActiveTargetId: homeViewState.activeTargetId,
        }
        : parsedSettings;
    safeSetPreferredLanguageFromSettings(settings.preferredLanguage);
    const localSettings = loadLocalSettings();
    const purchases = loadPurchases();

    function projectSettings(state: S, incoming: Settings, nextVersion: number | null, nextScope: AccountSettingsScope | null): S {
        const projected = buildSettingsProjectionState(state, incoming, nextVersion, nextScope);
        const selected = projected.settings.preferredLanguage;
        safeSetPreferredLanguageFromSettings(selected);
        if (!areTranslationsReadyForSettings(selected)) {
            void preloadTranslationsForSettings(selected).then(() => {
                set((current) => {
                    // A server echo, local edit or Account switch may supersede this request.
                    if (current.settings.preferredLanguage !== selected) return current;
                    const previousLanguage = getPreferredLanguage();
                    setPreferredLanguageFromSettings(selected);
                    if (getPreferredLanguage() === previousLanguage) return current;
                    // Activation and the existing settings subscription notification are atomic.
                    return { ...current, settings: { ...current.settings } };
                });
            }).catch((error: unknown) => {
                console.error('Failed to load preferred language; keeping the current locale:', error);
            });
        }
        return projected;
    }

    return {
        settings,
        settingsVersion: version,
        settingsScope: null,
        localSettings,
        purchases,
        applySettingsLocal: (delta) =>
            set((state) => {
                const newSettings = applySettings(state.settings, delta);
                if (areAccountSettingsJsonValuesEqual(newSettings, state.settings)) {
                    return state;
                }
                if (state.settingsScope) {
                    saveAccountSettings(state.settingsScope, newSettings, state.settingsVersion ?? 0);
                } else {
                    saveSettings(newSettings, state.settingsVersion ?? 0);
                }
                return projectSettings(state, newSettings, state.settingsVersion, state.settingsScope);
            }),
        applySettings: (nextSettings, nextVersion) =>
            set((state) => {
                if (state.settingsScope) {
                    if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                        saveAccountSettings(state.settingsScope, nextSettings, nextVersion);
                        return projectSettings(state, nextSettings, nextVersion, state.settingsScope);
                    }
                    return state;
                }
                if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                    saveSettings(nextSettings, nextVersion);
                    return projectSettings(state, nextSettings, nextVersion, null);
                }
                return state;
            }),
        activateSettingsScope: async (scope, legacyScopes = []) => {
            await prepareAccountSettingsScopeForActivation(scope, legacyScopes);
            prepareAccountProfileScopeForActivation(scope, legacyScopes);
            set((state) => {
                const loaded = loadParsedAccountSettings(scope);
                return {
                    ...projectSettings(state, loaded.settings, loaded.version, scope),
                    purchases: loadAccountPurchases(scope),
                };
            });
        },
        clearSettingsScope: () =>
            set((state) => ({
                ...projectSettings(state, { ...settingsDefaults }, null, null),
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
                return projectSettings(state, nextSettings, nextVersion, scope);
            }),
        applyLocalSettings: (delta, options) =>
            set((state) => {
                const previousLocalSettings = state.localSettings;
                const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
                if (areAccountSettingsJsonValuesEqual(updatedLocalSettings, previousLocalSettings)) {
                    return state;
                }
                if (options?.persist !== false) {
                    saveLocalSettings(updatedLocalSettings);
                    emitLocalSettingChangedEvents({
                        previousSettings: previousLocalSettings,
                        nextSettings: updatedLocalSettings,
                        source: options?.source,
                    });
                }
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
