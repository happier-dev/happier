import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { ProviderSettingsMigrationPendingConflictV1, ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';

const RETAINED_LEGACY_PROFILE_IDS = new Set(['azure-openai', 'gemini-api-key', 'gemini-vertex']);

export type ProfileMigrationStatus = 'review' | 'conflict' | 'retained';

export function resolveProfileMigrationConflict(input: Readonly<{
    profileId: string;
    providerSettings: ProviderSettingsV1 | null | undefined;
}>): ProviderSettingsMigrationPendingConflictV1 | null {
    return input.providerSettings?.migration?.pendingConflicts.find((entry) => entry.sourceProfileId === input.profileId) ?? null;
}

export function resolveProfileMigrationStatus(input: Readonly<{
    profile: AiLaunchProfile;
    providerSettings: ProviderSettingsV1 | null | undefined;
}>): ProfileMigrationStatus | null {
    if (isLaunchProfileV2(input.profile)) return null;
    const conflict = resolveProfileMigrationConflict({ profileId: input.profile.id, providerSettings: input.providerSettings });
    if (conflict) {
        return 'conflict';
    }
    if (RETAINED_LEGACY_PROFILE_IDS.has(input.profile.id)) return 'retained';
    return input.providerSettings?.migration?.pendingCustomProfileIds.includes(input.profile.id) ? 'review' : null;
}
