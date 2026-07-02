import type { AIBackendProfile } from './profileCompatibility';

export type ProfileEnabledById = Record<string, boolean>;

type ProfileEnablementInput = Pick<AIBackendProfile, 'id'> & Partial<Pick<AIBackendProfile, 'defaultEnabled'>>;

export function isProfileEnabled(
    profile: ProfileEnablementInput,
    profileEnabledById: ProfileEnabledById | null | undefined,
): boolean {
    const override = profileEnabledById?.[profile.id];
    if (typeof override === 'boolean') return override;
    return profile.defaultEnabled !== false;
}

export function setProfileEnabledOverride(
    profileEnabledById: ProfileEnabledById | null | undefined,
    profile: ProfileEnablementInput,
    enabled: boolean,
): ProfileEnabledById {
    const next = { ...(profileEnabledById ?? {}) };
    const defaultEnabled = profile.defaultEnabled !== false;

    if (enabled === defaultEnabled) {
        delete next[profile.id];
        return next;
    }

    next[profile.id] = enabled;
    return next;
}
