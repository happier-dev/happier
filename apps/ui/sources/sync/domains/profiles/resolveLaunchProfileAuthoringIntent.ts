import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import { buildBackendTargetKeyV2, resolveBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { normalizeLegacyAiLaunchProfileReferenceV1 } from '@happier-dev/protocol/providers/migrations/legacyProfileReferencesV1';
import type { ProviderSettingsMigrationStateV1 } from '@happier-dev/protocol/providers/settings/v1';
import { getProfileDefaultBackendTarget } from '@happier-dev/protocol/profiles/profileCompatibility';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';

export type LaunchProfileAuthoringIntent = Readonly<{
    profileId: string | null;
    preferredAgentTargetKey: string | null;
    modelSelection: SessionModelSelection | null;
}>;

export function resolveLaunchProfileAuthoringIntent(input: Readonly<{
    profileId: string | null;
    profiles: readonly AiLaunchProfile[];
    migration: ProviderSettingsMigrationStateV1 | undefined;
}>): LaunchProfileAuthoringIntent {
    const currentProfile = input.profiles.find(profile => profile.id === input.profileId);
    const currentTarget = currentProfile && (isLaunchProfileV2(currentProfile) || !currentProfile.isBuiltIn)
        ? getProfileDefaultBackendTarget(currentProfile) : null;
    const resolution = normalizeLegacyAiLaunchProfileReferenceV1({
        legacyAiLaunchProfileId: input.profileId,
        migration: input.migration,
        retainedSlimProfileIds: input.profiles.filter(isLaunchProfileV2).map((profile) => profile.id),
        ...(currentTarget ? { retainedProfileTargetKey: buildBackendTargetKeyV2(currentTarget) } : {}),
    });
    const retainedProfile = resolution.legacyAiLaunchProfileId
        ? input.profiles.find((profile) => profile.id === resolution.legacyAiLaunchProfileId)
        : undefined;
    const slim = retainedProfile && isLaunchProfileV2(retainedProfile) ? retainedProfile : null;
    const migratedModelSelection = resolution.modelRef ? {
        v: 1 as const,
        updatedAt: input.migration?.migratedAt ?? 0,
        ref: { ...resolution.modelRef, agentTargetKey: resolveBackendTargetKeyV2(resolution.modelRef.agentTargetKey) },
    } : null;
    const modelSelection = resolution.status === 'review_required' ? null
        : slim ? slim.preferredModelSelection ?? null : migratedModelSelection;
    const preferredTarget = getProfileDefaultBackendTarget({
        ...retainedProfile,
        preferredModelSelection: modelSelection ?? undefined,
    });
    return {
        profileId: resolution.legacyAiLaunchProfileId,
        preferredAgentTargetKey: preferredTarget ? buildBackendTargetKeyV2(preferredTarget) : null,
        modelSelection,
    };
}
