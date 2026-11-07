import {
    RETIRED_ACCOUNT_SETTINGS_SESSION_ONLY_KEYS,
    RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS,
} from './accountSettings.js';

/**
 * Protocol owns persisted Account-root retirement. UI consumes only the two
 * subsets it must keep out of device-local session organization persistence.
 */
export const DEPRECATED_SESSION_ONLY_SETTINGS_KEYS = new Set<string>(
    RETIRED_ACCOUNT_SETTINGS_SESSION_ONLY_KEYS,
);

export const MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS = new Set<string>(
    RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS,
);

export function stripDeprecatedSessionOnlyKeys<TSettings extends Record<string, unknown>>(settings: TSettings): TSettings {
    const next = { ...settings };
    for (const key of DEPRECATED_SESSION_ONLY_SETTINGS_KEYS) {
        if (key in next) {
            delete next[key];
        }
    }
    return next;
}

export function stripMigratedSessionOrganizationSettings<TSettings extends Record<string, unknown>>(settings: TSettings): TSettings {
    const next = { ...settings };
    for (const key of MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS) {
        if (key in next) {
            delete next[key];
        }
    }
    return next;
}

/**
 * One decider for whether an already-transferred destination still owes its
 * legacy-source pass (source read, contraction and history normalization).
 * Only a raw Account Settings document already admitted for this same Account
 * can prove the pass finished; an unknown document always keeps the pass.
 * Supported writers never re-add a transferred root, so an older document can
 * only over-report the source.
 */
export function transferredAccountSettingsSourceNeedsCleanupV1(input: Readonly<{
    rawSettings: Readonly<Record<string, unknown>> | null | undefined;
    sourceRoots: readonly string[];
    cleanupPending: boolean;
}>): boolean {
    const raw = input.rawSettings;
    return input.cleanupPending || !raw || input.sourceRoots.some(root => Object.hasOwn(raw, root));
}
