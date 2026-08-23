import { describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'profile-id',
}));

import { AIBackendProfileSchema } from './profileCompatibility';
import { buildProfileSaveSettingsDelta, createEmptyCustomProfile } from './profileMutations';

describe('createEmptyCustomProfile', () => {
    it('seeds canonical target-keyed compatibility for built-in backends without mirroring legacy compatibility', () => {
        expect(createEmptyCustomProfile()).toMatchObject({
            id: 'profile-id',
            isBuiltIn: false,
            compatibility: {},
            compatibilityByTargetKey: {
                'agent:claude': true,
                'agent:codex': true,
                'agent:gemini': true,
            },
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByTargetKey: {},
        });
    });
});

describe('buildProfileSaveSettingsDelta', () => {
    it('commits a new profile and its draft secret bindings in the same settings delta', () => {
        const profile = AIBackendProfileSchema.parse({
            ...createEmptyCustomProfile(),
            id: 'custom-profile',
            name: 'Custom',
            environmentVariables: [{ name: 'TEST_API_KEY', value: '', isSecret: true }],
            envVarRequirements: [{ name: 'TEST_API_KEY', kind: 'secret', required: true }],
        });

        expect(buildProfileSaveSettingsDelta({
            profiles: [],
            secretBindingsByProfileId: {},
            profile,
            profileSecretBindings: { TEST_API_KEY: 'secret-1' },
        })).toEqual({
            profiles: [profile],
            secretBindingsByProfileId: {
                'custom-profile': { TEST_API_KEY: 'secret-1' },
            },
        });
    });
});
