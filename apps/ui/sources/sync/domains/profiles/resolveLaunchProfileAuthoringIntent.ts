import {
    isLaunchProfileV2,
    buildBackendTargetKeyV2,
    normalizeLegacyAiLaunchProfileReferenceV1,
    readBackendTargetRefV2,
    type AiLaunchProfile,
    type ProviderSettingsMigrationStateV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';

export type LaunchProfileAuthoringIntent = Readonly<{
    profileId: string | null;
    preferredAgentTargetKey: string | null;
    modelSelection: SessionModelSelectionV1 | null;
}>;

function normalizeAuthoringTargetKey(targetKey: string): string {
    return buildBackendTargetKeyV2(readBackendTargetRefV2(targetKey));
}

function normalizeAuthoringModelSelection(
    selection: SessionModelSelectionV1 | null,
): SessionModelSelectionV1 | null {
    if (!selection) return null;
    return {
        ...selection,
        ref: {
            ...selection.ref,
            agentTargetKey: normalizeAuthoringTargetKey(selection.ref.agentTargetKey),
        },
    };
}

export function resolveLaunchProfileAuthoringIntent(input: Readonly<{
    profileId: string | null;
    profiles: readonly AiLaunchProfile[];
    migration: ProviderSettingsMigrationStateV1 | undefined;
}>): LaunchProfileAuthoringIntent {
    const resolution = normalizeLegacyAiLaunchProfileReferenceV1({
        legacyAiLaunchProfileId: input.profileId,
        migration: input.migration,
        retainedSlimProfileIds: input.profiles.filter(isLaunchProfileV2).map((profile) => profile.id),
    });
    const retainedProfile = resolution.legacyAiLaunchProfileId
        ? input.profiles.find((profile) => profile.id === resolution.legacyAiLaunchProfileId)
        : undefined;
    const slim = retainedProfile && isLaunchProfileV2(retainedProfile) ? retainedProfile : null;
    const migratedModelSelection = resolution.modelRef ? {
        v: 1 as const,
        updatedAt: input.migration?.migratedAt ?? 0,
        ref: resolution.modelRef,
    } : null;
    const modelSelection = normalizeAuthoringModelSelection(
        migratedModelSelection
            ?? (resolution.status === 'review_required' ? null : slim?.preferredModelSelection)
            ?? null,
    );
    return {
        profileId: resolution.legacyAiLaunchProfileId,
        preferredAgentTargetKey: modelSelection?.ref.agentTargetKey
            ?? (slim?.preferredAgentTargetKey ? normalizeAuthoringTargetKey(slim.preferredAgentTargetKey) : null),
        modelSelection,
    };
}
