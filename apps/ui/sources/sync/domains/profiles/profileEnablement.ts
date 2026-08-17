import type { AccountSettingsDefaults } from '@happier-dev/protocol';

import type { AIBackendProfile } from './profileCompatibility';

export type ProfileEnabledById = Record<string, boolean>;

type ProfileEnabledByIdRaw = AccountSettingsDefaults['profileEnabledById'];

type ProfileEnablementInput = Pick<AIBackendProfile, 'id'> & Partial<Pick<AIBackendProfile, 'defaultEnabled'>>;

/**
 * `profileEnabledById` is a retained Account JSON root. Profile consumers use
 * only its boolean overrides; other compatible entries remain available to
 * the persistence writer unchanged.
 */
export function readProfileEnabledById(raw: unknown): ProfileEnabledById {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const overrides: ProfileEnabledById = {};
    for (const [profileId, value] of Object.entries(raw)) {
        if (typeof value === 'boolean') {
            overrides[profileId] = value;
        }
    }
    return overrides;
}

export function isProfileEnabled(
    profile: ProfileEnablementInput,
    profileEnabledById: ProfileEnabledById | null | undefined,
): boolean {
    const override = profileEnabledById?.[profile.id];
    if (typeof override === 'boolean') return override;
    return profile.defaultEnabled !== false;
}

export function setProfileEnabledOverride(
    profileEnabledById: ProfileEnabledByIdRaw | null | undefined,
    profile: ProfileEnablementInput,
    enabled: boolean,
): ProfileEnabledByIdRaw {
    const next: ProfileEnabledByIdRaw = { ...(profileEnabledById ?? {}) };
    const defaultEnabled = profile.defaultEnabled !== false;

    if (enabled === defaultEnabled) {
        delete next[profile.id];
        return next;
    }

    next[profile.id] = enabled;
    return next;
}
