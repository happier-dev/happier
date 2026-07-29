import {
    resolveVisibleBuiltInAiLaunchProfilesV1,
    type AIBackendProfile,
    type ProviderSettingsMigrationStateV1,
} from '@happier-dev/protocol';

/** UI adapter over the protocol-owned post-demotion evidence policy. */
export function resolveVisibleBuiltInLaunchProfiles(input: Readonly<{
    lastUsedProfile: string | null;
    favoriteProfileIds: readonly string[];
    profileEnabledById: Readonly<Record<string, boolean>>;
    secretBindingsByProfileId: Readonly<Record<string, Readonly<Record<string, string>>>>;
    migration?: ProviderSettingsMigrationStateV1;
}>): AIBackendProfile[] {
    return resolveVisibleBuiltInAiLaunchProfilesV1({
        evidence: {
            lastUsedProfile: input.lastUsedProfile,
            favoriteProfileIds: input.favoriteProfileIds,
            profileEnabledById: input.profileEnabledById,
            secretBindingsByProfileId: input.secretBindingsByProfileId,
        },
        migration: input.migration,
    });
}
