import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';

export function buildAnalyticsProfile(overrides: Record<string, unknown> = {}) {
    return AIBackendProfileSchema.parse({
        id: 'profile',
        name: 'Profile',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: {},
        compatibilityByTargetKey: {},
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 1,
        updatedAt: 1,
        version: '1.0.0',
        ...overrides,
    });
}

export function buildSecretValue(value: string) {
    return { _isSecretValue: true as const, value };
}

export function buildEncryptedSecretValue(ciphertext: string) {
    return { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: ciphertext } };
}

