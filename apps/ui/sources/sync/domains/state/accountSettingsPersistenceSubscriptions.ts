import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { publishStoragePaths, subscribeStoragePaths } from './storageSubscriptions';

type MutationListener = (scope: AccountSettingsScope) => void;

/** Envelope observers retain version notifications; preference consumers declare exact scope/key demand. */
export function subscribeAccountSettingsPersistenceMutations(listener: MutationListener,
    options?: Readonly<{ scope: AccountSettingsScope; keys: readonly (keyof Settings)[] }>): () => void {
    return subscribeStoragePaths(options
        ? options.keys.map(key => ['persistedSettings', accountSettingsScopeKeySuffix(options.scope), key])
        : [['persistedSettings']], event => {
        if (event.kind === 'settings') {
            try { listener(event.scope); } catch { /* persistence success remains authoritative */ }
        }
    });
}

function accountSettingsValueEqual(key: keyof Settings, previous: unknown, next: unknown): boolean {
    return areAccountSettingsJsonValuesEqual(previous ?? settingsDefaults[key], next ?? settingsDefaults[key]);
}

/** Remote read projections use the same consumed-key decision as persisted Settings publications. */
export function accountSettingsKeysChanged(previous: Readonly<Record<string, unknown>> | undefined,
    next: Readonly<Record<string, unknown>>, keys: readonly (keyof Settings)[]): boolean {
    return previous === undefined || keys.some(key => !accountSettingsValueEqual(key, previous[key], next[key]));
}

/** Called only by the canonical persisted-settings writer, after its atomic envelope write. */
export function publishAccountSettingsPersistenceMutation(scope: AccountSettingsScope,
    previousSettings: Readonly<Record<string, unknown>> | undefined, settings: Partial<Settings>): void {
    const scopeKey = accountSettingsScopeKeySuffix(scope);
    publishStoragePaths(['persistedSettings'], { [scopeKey]: settings }, { [scopeKey]: previousSettings },
        { kind: 'settings', scope }, (path, next, previous) => path.length === 3
            ? previousSettings !== undefined && accountSettingsValueEqual(path[2] as keyof Settings, previous, next) : Object.is(next, previous));
}


/** Pending consumers observe only fields that affect their composed view. */
export function subscribePendingAccountSettingsPersistenceMutations(listener: MutationListener,
    options: Readonly<{ scope: AccountSettingsScope; keys: readonly PropertyKey[] }>): () => void {
    return subscribeStoragePaths(options.keys.map(key => ['pendingSettings', accountSettingsScopeKeySuffix(options.scope), key]), event => {
        if (event.kind === 'settings') {
            try { listener(event.scope); } catch { /* persistence success remains authoritative */ }
        }
    });
}

export function publishPendingAccountSettingsPersistenceMutation(scope: AccountSettingsScope,
    previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): void {
    const scopeKey = accountSettingsScopeKeySuffix(scope);
    publishStoragePaths(['pendingSettings'], { [scopeKey]: next }, { [scopeKey]: previous },
        { kind: 'settings', scope }, (path, after, before) => path.length === 3
            ? areAccountSettingsJsonValuesEqual(after, before) : Object.is(after, before));
}
