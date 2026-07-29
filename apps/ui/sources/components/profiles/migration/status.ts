import {
    isLaunchProfileV2,
    readProviderSettingsFromAccountSettingsV1,
    type AiLaunchProfile,
    type ProviderSettingsMigrationPendingConflictV1,
} from '@happier-dev/protocol';

const RETAINED_LEGACY_PROFILE_IDS = new Set(['azure-openai', 'gemini-api-key', 'gemini-vertex']);

export type ProfileMigrationStatus = 'review' | 'conflict' | 'retained';

export function resolveProfileMigrationConflict(input: Readonly<{
    profileId: string;
    providerSettings: unknown;
}>): ProviderSettingsMigrationPendingConflictV1 | null {
    const read = readProviderSettingsFromAccountSettingsV1({ providerSettingsV1: input.providerSettings });
    return read.settings.migration?.pendingConflicts.find((entry) => entry.sourceProfileId === input.profileId) ?? null;
}

export function resolveProfileMigrationStatus(input: Readonly<{
    profile: AiLaunchProfile;
    providerSettings: unknown;
}>): ProfileMigrationStatus | null {
    if (isLaunchProfileV2(input.profile)) return null;
    const conflict = resolveProfileMigrationConflict({ profileId: input.profile.id, providerSettings: input.providerSettings });
    if (conflict) {
        return 'conflict';
    }
    if (RETAINED_LEGACY_PROFILE_IDS.has(input.profile.id)) return 'retained';
    const read = readProviderSettingsFromAccountSettingsV1({ providerSettingsV1: input.providerSettings });
    return read.settings.migration?.pendingCustomProfileIds.includes(input.profile.id) ? 'review' : null;
}
