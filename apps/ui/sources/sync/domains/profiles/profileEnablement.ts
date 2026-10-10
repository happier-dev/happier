import type { AccountSettingsDefaults } from '@happier-dev/protocol';
import { readAiLaunchProfileEnabledV1 } from '@happier-dev/protocol/profiles/read';
import { setProfileEnabledOverrideV1 } from '@happier-dev/protocol/profiles/profileOperations';

import type { AIBackendProfile } from './profileCompatibility';

export type ProfileEnabledById = Record<string, boolean>;

type ProfileEnabledByIdRaw = AccountSettingsDefaults['profileEnabledById'];

type ProfileEnablementInput = Pick<AIBackendProfile, 'id'> & Partial<Pick<AIBackendProfile, 'defaultEnabled' | 'isBuiltIn'>>
    & Readonly<{ enabled?: boolean; artifactId?: string }>;

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
    return readAiLaunchProfileEnabledV1(profile, profileEnabledById ?? {});
}

export function setProfileEnabledOverride(
    profileEnabledById: ProfileEnabledByIdRaw | null | undefined,
    profile: ProfileEnablementInput,
    enabled: boolean,
): ProfileEnabledByIdRaw {
    return setProfileEnabledOverrideV1(profileEnabledById, profile, enabled);
}
