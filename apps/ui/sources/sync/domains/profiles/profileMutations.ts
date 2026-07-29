import { randomUUID } from '@/platform/randomUUID';
import {
    LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1,
    buildBackendTargetKeyV2,
    isLaunchProfileV2,
    type AiLaunchProfile,
    type LaunchProfileV2,
} from '@happier-dev/protocol';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

export function createEmptyCustomProfile(): LaunchProfileV2 {
    return {
        v: 2,
        id: randomUUID(),
        name: '',
        extraEnvironmentVariables: [],
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByTargetKey: {},
        compatibilityByTargetKey: {
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' })]: true,
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' })]: true,
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini', sourceKind: 'built_in' })]: true,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

function toSlimProfile(profile: AiLaunchProfile): LaunchProfileV2 {
    if (isLaunchProfileV2(profile)) return profile;
    return {
        v: 2,
        id: profile.id,
        name: profile.name,
        ...(profile.description !== undefined ? { description: profile.description } : {}),
        extraEnvironmentVariables: profile.environmentVariables.filter(
            (entry) => !LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1.has(entry.name),
        ),
        defaultPermissionModeByTargetKey: profile.defaultPermissionModeByTargetKey ?? {},
        defaultPersistenceModeByTargetKey: profile.defaultPersistenceModeByTargetKey ?? {},
        compatibilityByTargetKey: profile.compatibilityByTargetKey ?? {},
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
    };
}

export function duplicateProfileForEdit(profile: AiLaunchProfile, opts?: { copySuffix?: string }): LaunchProfileV2 {
    const suffix = opts?.copySuffix ?? '(Copy)';
    const separator = profile.name.trim().length > 0 ? ' ' : '';
    const slim = toSlimProfile(profile);
    return {
        ...slim,
        id: randomUUID(),
        name: `${profile.name}${separator}${suffix}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

export function convertBuiltInProfileToCustom(profile: AIBackendProfile): LaunchProfileV2 {
    const slim = toSlimProfile(profile);
    return {
        ...slim,
        id: randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}
