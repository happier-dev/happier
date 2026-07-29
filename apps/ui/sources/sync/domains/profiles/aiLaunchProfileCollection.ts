import {
    AIBackendProfileSchema,
    isLaunchProfileV2,
    readAiLaunchProfileCollection,
    type AIBackendProfile,
    type AiLaunchProfile,
} from '@happier-dev/protocol';

export function projectAiLaunchProfileForLegacyUi(profile: AiLaunchProfile): AIBackendProfile {
    if (!isLaunchProfileV2(profile)) return profile;
    return AIBackendProfileSchema.parse({
        id: profile.id,
        name: profile.name,
        ...(profile.description !== undefined ? { description: profile.description } : {}),
        environmentVariables: profile.extraEnvironmentVariables,
        envVarRequirements: [],
        defaultPermissionModeByTargetKey: profile.defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey: profile.defaultPersistenceModeByTargetKey,
        compatibilityByTargetKey: profile.compatibilityByTargetKey,
        compatibility: {},
        isBuiltIn: false,
        defaultEnabled: true,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        version: '2.0.0',
    });
}

export function readUiAiLaunchProfiles(raw: unknown): readonly AiLaunchProfile[] {
    return readAiLaunchProfileCollection(raw).entries.flatMap((entry) => (
        entry.kind === 'opaque' ? [] : [entry.profile]
    ));
}

function asRawCollection(raw: unknown): readonly unknown[] {
    return Array.isArray(raw) ? raw : [];
}

export function appendAiLaunchProfile(raw: unknown, profile: AiLaunchProfile): readonly unknown[] {
    if (readUiAiLaunchProfiles(raw).some((entry) => entry.id === profile.id)) {
        throw new Error(`AI launch profile '${profile.id}' already exists`);
    }
    return [...asRawCollection(raw), profile];
}

export function replaceAiLaunchProfile(
    raw: unknown,
    profileId: string,
    replacement: AiLaunchProfile,
): readonly unknown[] {
    let replaced = false;
    const entries = readAiLaunchProfileCollection(raw).entries;
    const next = entries.map((entry) => {
        if (entry.kind === 'opaque' || entry.profile.id !== profileId) return entry.raw;
        replaced = true;
        return replacement;
    });
    if (!replaced) throw new Error(`AI launch profile '${profileId}' does not exist`);
    return next;
}

export function removeAiLaunchProfile(raw: unknown, profileId: string): readonly unknown[] {
    return readAiLaunchProfileCollection(raw).entries.flatMap((entry) => (
        entry.kind !== 'opaque' && entry.profile.id === profileId ? [] : [entry.raw]
    ));
}
