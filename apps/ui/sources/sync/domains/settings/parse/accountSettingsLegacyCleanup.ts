import {
    RETIRED_ACCOUNT_SETTINGS_SESSION_ONLY_KEYS,
    RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS,
} from '@happier-dev/protocol';

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
