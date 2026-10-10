import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { DEFAULT_PROFILES, getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import type { AgentId } from '@/agents/catalog/catalog';
import { getProfileCompatibleAgentIds } from '@/sync/domains/profiles/profileUtils';
import { isProfileEnabled, type ProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
export { toggleFavoriteProfileId } from '@happier-dev/protocol/profiles/profileOperations';

export interface ProfileGroups {
    favoriteProfiles: AIBackendProfile[];
    /** The reader's own saved profiles. */
    customProfiles: AIBackendProfile[];
    /** Profiles people and Teams share with the reader (ORC §3.10 "Shared with you"), unless a favorite. */
    sharedProfiles: AIBackendProfile[];
    builtInProfiles: AIBackendProfile[];
    favoriteIds: Set<string>;
    builtInIds: Set<string>;
}

function isProfile(profile: AIBackendProfile | null | undefined): profile is AIBackendProfile {
    return Boolean(profile);
}

/** A profile another Account shares with the reader (its Artifact grant, read by the profile reader). */
function isSharedWithReader(profile: AIBackendProfile): boolean {
    return 'shared' in profile && profile.shared === true;
}

export function buildProfileGroups({
    customProfiles,
    builtInProfiles,
    favoriteProfileIds,
    enabledAgentIds,
    profileEnabledById,
    includeDisabledProfiles = false,
}: {
    customProfiles: AIBackendProfile[];
    builtInProfiles?: AIBackendProfile[];
    favoriteProfileIds: string[];
    enabledAgentIds?: readonly AgentId[];
    profileEnabledById?: ProfileEnabledById | null;
    includeDisabledProfiles?: boolean;
}): ProfileGroups {
    const resolvedBuiltInProfiles = builtInProfiles ?? DEFAULT_PROFILES
        .map((profile) => getBuiltInProfile(profile.id))
        .filter(isProfile);
    const builtInIds = new Set(resolvedBuiltInProfiles.map((profile) => profile.id));

    const customById = new Map(customProfiles.map((profile) => [profile.id, profile] as const));
    const builtInById = new Map(resolvedBuiltInProfiles.map((profile) => [profile.id, profile] as const));

    const isVisible = (profile: AIBackendProfile): boolean => {
        if (!includeDisabledProfiles && !isProfileEnabled(profile, profileEnabledById)) return false;
        if (!enabledAgentIds) return true;
        return getProfileCompatibleAgentIds(profile, enabledAgentIds).length > 0;
    };

    const favoriteProfiles = favoriteProfileIds
        .map((id) => customById.get(id) ?? builtInById.get(id))
        .filter(isProfile);
    const visibleFavoriteProfiles = favoriteProfiles.filter(isVisible);

    const favoriteIds = new Set<string>(visibleFavoriteProfiles.map((profile) => profile.id));
    // Preserve "default environment" favorite marker (not a real profile object).
    if (favoriteProfileIds.includes('')) {
        favoriteIds.add('');
    }

    const nonFavoriteCustomProfiles = customProfiles
        .filter(isVisible)
        .filter((profile) => !favoriteIds.has(profile.id));
    const ownProfiles = nonFavoriteCustomProfiles.filter((profile) => !isSharedWithReader(profile));
    const sharedProfiles = nonFavoriteCustomProfiles.filter(isSharedWithReader);

    const nonFavoriteBuiltInProfiles = resolvedBuiltInProfiles
        .filter(isVisible)
        .filter((profile) => !favoriteIds.has(profile.id));

    return {
        favoriteProfiles: visibleFavoriteProfiles,
        customProfiles: ownProfiles,
        sharedProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds,
        builtInIds,
    };
}
