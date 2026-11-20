import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import type { CustomerInfo } from '../../domains/purchases/types';
import type { PushTokensRemoteAlertProjectionV2 } from '@happier-dev/protocol/push/pushTokenRegistration';
import type { MachineDisplayRenderable } from '../../domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '../../domains/state/storageTypes';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { applyLocalSettings, type LocalSettings } from '../../domains/settings/localSettings';
import { customerInfoToPurchases, purchasesDefaults, type Purchases } from '../../domains/purchases/purchases';
import { applySettings, projectRuntimeAccountSettings, settingsDefaults, settingsParse, type Settings } from '../../domains/settings/settings';
import {
    loadAccountSettings,
    prepareAccountSettingsScopeForActivation,
    saveAccountSettings,
    saveActiveAccountSettingsScope,
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
import { loadLocalSettings, loadPurchases, saveLocalSettings, saveLocalSettingsDelta, savePurchases, saveSettings, subscribeLocalSettingsChanges } from '../../domains/state/settingsPersistence';
import { loadStartupAccountSettings } from '../../domains/state/startupAccountSettings';
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
import { projectSavedSecretReferenceSettings } from './settingsSavedSecretReferences';
import { readOrdinarySessionListRowsForServer } from './sessionListIndexFinalization';

function reconcilePurchasesReferences(previous: Purchases, next: Purchases): Purchases {
    if (areAccountSettingsJsonValuesEqual(previous, next)) return previous;
    return {
        ...next,
        activeSubscriptions: areAccountSettingsJsonValuesEqual(previous.activeSubscriptions, next.activeSubscriptions)
            ? previous.activeSubscriptions : next.activeSubscriptions,
        entitlements: areAccountSettingsJsonValuesEqual(previous.entitlements, next.entitlements)
            ? previous.entitlements : next.entitlements,
    };
}

function reconcileLocalSettingsReferences(previous: LocalSettings, next: LocalSettings): LocalSettings {
    const reconciled = { ...next };
    const previousRecord = previous as Record<string, unknown>;
    const reconciledRecord = reconciled as Record<string, unknown>;
    for (const key of Object.keys(next)) {
        if (Object.prototype.hasOwnProperty.call(previousRecord, key)
            && areAccountSettingsJsonValuesEqual(previousRecord[key], reconciledRecord[key])) {
            reconciledRecord[key] = previousRecord[key];
        }
    }
    return reconciled;
}

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
    /** Raw census inputs, published only when a reference-bearing Settings root changes. */
    savedSecretReferenceSettings: Readonly<Record<string, unknown>>;
    settingsVersion: number | null;
    settingsScope: AccountSettingsScope | null;
    /** Server-produced status for the accepted Settings version; never persisted as a preference. */
    settingsRemoteAlertPolicyStatus: PushTokensRemoteAlertProjectionV2['accountRemoteAlerts']['status'] | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    applySettingsLocal: (delta: Partial<Settings>) => void;
    applySettings: (settings: Settings, version: number, remoteAlertPolicyStatus?: PushTokensRemoteAlertProjectionV2['accountRemoteAlerts']['status']) => void;
    activateSettingsScope: (scope: AccountSettingsScope, legacyScopes?: readonly AccountSettingsScope[]) => Promise<void>;
    clearSettingsScope: () => void;
    applySettingsForScope: (scope: AccountSettingsScope, settings: Settings, version: number, remoteAlertPolicyStatus?: PushTokensRemoteAlertProjectionV2['accountRemoteAlerts']['status']) => void;
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

function rebuildSessionListIndexesForSettingsChange(
    state: SettingsDomainState,
    nextSettings: Settings,
): Readonly<Record<string, SessionListIndexItem[] | null | undefined>> {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    let nextSessionListIndexByServerId = state.sessionListIndexByServerId ?? {};

    if (activeServerId) {
        const previousActiveIndex = nextSessionListIndexByServerId[activeServerId] ?? null;
        const nextActiveIndex = buildActiveServerSessionListIndex({
            sessions: readOrdinarySessionListRowsForServer(state, activeServerId),
            sessionRecords: state.sessions,
            machines: state.machineDisplayById,
            machineRecords: state.machines,
            layoutV1: nextSettings.sessionListLayoutV1,
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
        const nextIndex = buildSessionListIndexWithServerScope({
            sessions: readOrdinarySessionListRowsForServer(state, serverId),
            machines: buildMachineDisplaysByIdFromMachineList(state.machineListByServerId?.[serverId]),
            layoutV1: nextSettings.sessionListLayoutV1,
            serverScope: {
                serverId,
                serverName: entry?.serverName ?? undefined,
            },
            previousIndex: nextSessionListIndexByServerId[serverId] ?? null,
        });
        if (nextIndex === nextSessionListIndexByServerId[serverId]) continue;
        concurrentUpdates[serverId] = nextIndex;
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
    remoteAlertPolicyStatus?: PushTokensRemoteAlertProjectionV2['accountRemoteAlerts']['status'],
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

    const settingsScope = state.settingsScope === nextScope || areAccountSettingsScopesEqual(state.settingsScope, nextScope)
        ? state.settingsScope : nextScope;
    const nextRemoteAlertPolicyStatus = remoteAlertPolicyStatus
        ?? (settingsScope === state.settingsScope && nextVersion === state.settingsVersion
            ? state.settingsRemoteAlertPolicyStatus : null);
    if (nextSettings === state.settings && nextVersion === state.settingsVersion && settingsScope === state.settingsScope
        && nextRemoteAlertPolicyStatus === state.settingsRemoteAlertPolicyStatus
        && nextSessionListIndexByServerId === state.sessionListIndexByServerId) return state;

    return {
        ...state,
        settings: nextSettings,
        savedSecretReferenceSettings: projectSavedSecretReferenceSettings(nextSettings, state.settings, state.savedSecretReferenceSettings),
        settingsVersion: nextVersion,
        settingsScope,
        settingsRemoteAlertPolicyStatus: nextRemoteAlertPolicyStatus,
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
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SettingsDomain {
    // The realm's singleton store observes external writes before taking its initial snapshot.
    subscribeLocalSettingsChanges(delta => get().applyLocalSettings(delta, { persist: false }));
    const { settings: parsedSettings } = loadStartupAccountSettings();
    const homeViewState = loadHomeViewState();
    const settings = homeViewState
        ? projectRuntimeAccountSettings({
            ...parsedSettings,
            serverSelectionGroups: normalizeServerSelectionGroupsForSettings(homeViewState.groups),
            serverSelectionActiveTargetKind: homeViewState.activeTargetKind,
            serverSelectionActiveTargetId: homeViewState.activeTargetId,
        })
        : parsedSettings;
    safeSetPreferredLanguageFromSettings(settings.preferredLanguage);
    const localSettings = loadLocalSettings();
    const purchases = loadPurchases();

    function projectSettings(state: S, incoming: Settings, nextVersion: number | null, nextScope: AccountSettingsScope | null,
        remoteAlertPolicyStatus?: PushTokensRemoteAlertProjectionV2['accountRemoteAlerts']['status']): S {
        const projected = buildSettingsProjectionState(state, incoming, nextVersion, nextScope, remoteAlertPolicyStatus);
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
                    return { ...current, settings: projectRuntimeAccountSettings({ ...current.settings }) };
                });
            }).catch((error: unknown) => {
                console.error('Failed to load preferred language; keeping the current locale:', error);
            });
        }
        return projected;
    }

    return {
        settings,
        savedSecretReferenceSettings: projectSavedSecretReferenceSettings(settings),
        settingsVersion: null,
        settingsScope: null,
        settingsRemoteAlertPolicyStatus: null,
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
        applySettings: (nextSettings, nextVersion, remoteAlertPolicyStatus) =>
            set((state) => {
                if (state.settingsVersion === nextVersion && remoteAlertPolicyStatus !== undefined) {
                    return projectSettings(state, state.settings, nextVersion, state.settingsScope, remoteAlertPolicyStatus);
                }
                if (state.settingsScope) {
                    if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                        saveAccountSettings(state.settingsScope, nextSettings, nextVersion);
                        return projectSettings(state, nextSettings, nextVersion, state.settingsScope, remoteAlertPolicyStatus);
                    }
                    return state;
                }
                if (state.settingsVersion == null || state.settingsVersion < nextVersion) {
                    saveSettings(nextSettings, nextVersion);
                    return projectSettings(state, nextSettings, nextVersion, null, remoteAlertPolicyStatus);
                }
                return state;
            }),
        activateSettingsScope: async (scope, legacyScopes = []) => {
            await prepareAccountSettingsScopeForActivation(scope, legacyScopes);
            prepareAccountProfileScopeForActivation(scope, legacyScopes);
            set((state) => {
                const loaded = loadParsedAccountSettings(scope);
                if (legacyScopes.some(legacyScope => areAccountSettingsScopesEqual(
                    readThemeProfileLegacyAccountScope(), legacyScope,
                ))) writeThemeProfileLegacyAccountScope(scope);
                saveActiveAccountSettingsScope(scope);
                const projected = projectSettings(state, loaded.settings, loaded.version, scope);
                const purchases = reconcilePurchasesReferences(state.purchases, loadAccountPurchases(scope));
                return purchases === state.purchases ? projected : { ...projected, purchases };
            });
        },
        clearSettingsScope: () =>
            set((state) => {
                saveActiveAccountSettingsScope(null);
                const projected = projectSettings(state, settingsDefaults, null, null);
                const purchases = reconcilePurchasesReferences(state.purchases, purchasesDefaults);
                return purchases === state.purchases ? projected : { ...projected, purchases };
            }),
        applySettingsForScope: (scope, nextSettings, nextVersion, remoteAlertPolicyStatus) =>
            set((state) => {
                if (!shouldAcceptScopedSettings(scope, nextVersion)) {
                    if (state.settingsVersion === nextVersion && remoteAlertPolicyStatus !== undefined
                        && areAccountSettingsScopesEqual(state.settingsScope, scope)) {
                        return projectSettings(state, state.settings, nextVersion, scope, remoteAlertPolicyStatus);
                    }
                    return state;
                }
                saveAccountSettings(scope, nextSettings, nextVersion);
                if (!areAccountSettingsScopesEqual(state.settingsScope, scope)) {
                    return state;
                }
                return projectSettings(state, nextSettings, nextVersion, scope, remoteAlertPolicyStatus);
            }),
        applyLocalSettings: (delta, options) =>
            set((state) => {
                const previousLocalSettings = state.localSettings;
                const persistedChange = options?.persist !== false ? saveLocalSettingsDelta(delta) : null;
                const incomingLocalSettings = persistedChange?.nextSettings ?? applyLocalSettings(state.localSettings, delta);
                if (persistedChange && persistedChange.nextSettings !== persistedChange.previousSettings) {
                    emitLocalSettingChangedEvents({
                        previousSettings: persistedChange.previousSettings,
                        nextSettings: persistedChange.nextSettings,
                        source: options?.source,
                    });
                }
                if (areAccountSettingsJsonValuesEqual(incomingLocalSettings, previousLocalSettings)) {
                    return state;
                }
                const updatedLocalSettings = reconcileLocalSettingsReferences(previousLocalSettings, incomingLocalSettings);
                return {
                    ...state,
                    localSettings: updatedLocalSettings,
                };
            }),
        applyPurchases: (customerInfo) =>
            set((state) => {
                const nextPurchases = reconcilePurchasesReferences(state.purchases, customerInfoToPurchases(customerInfo));
                if (state.settingsScope) {
                    saveAccountPurchases(state.settingsScope, nextPurchases);
                } else {
                    savePurchases(nextPurchases);
                }
                if (nextPurchases === state.purchases) return state;
                return {
                    ...state,
                    purchases: nextPurchases,
                };
            }),
    };
}
