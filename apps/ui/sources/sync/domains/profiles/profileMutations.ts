import { randomUUID } from '@/platform/randomUUID';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

export function createEmptyCustomProfile(): AIBackendProfile {
    return {
        id: randomUUID(),
        name: '',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: {},
        compatibilityByTargetKey: {
            'agent:claude': true,
            'agent:codex': true,
            'agent:gemini': true,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        defaultEnabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: '1.0.0',
    };
}

export function duplicateProfileForEdit(profile: AIBackendProfile, opts?: { copySuffix?: string }): AIBackendProfile {
    const suffix = opts?.copySuffix ?? '(Copy)';
    const separator = profile.name.trim().length > 0 ? ' ' : '';
    return {
        ...profile,
        id: randomUUID(),
        name: `${profile.name}${separator}${suffix}`,
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

export function convertBuiltInProfileToCustom(profile: AIBackendProfile): AIBackendProfile {
    return {
        ...profile,
        id: randomUUID(),
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}
