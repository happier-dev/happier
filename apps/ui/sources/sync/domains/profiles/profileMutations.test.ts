import { describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'profile-id',
}));

import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileForEdit } from './profileMutations';

describe('createEmptyCustomProfile', () => {
    it('creates a slim V2 launch profile that cannot own provider routing or credentials', () => {
        expect(createEmptyCustomProfile()).toMatchObject({
            v: 2,
            id: 'profile-id',
            extraEnvironmentVariables: [],
            compatibilityByTargetKey: {
                'backend:claude': true,
                'backend:codex': true,
                'backend:gemini': true,
            },
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByTargetKey: {},
        });
        expect(createEmptyCustomProfile()).not.toHaveProperty('environmentVariables');
        expect(createEmptyCustomProfile()).not.toHaveProperty('envVarRequirements');
    });

    it('converts or duplicates legacy profiles into slim V2 without routing/auth environment', () => {
        const legacy = {
            id: 'legacy-provider', name: 'Legacy', description: 'Keep me',
            environmentVariables: [
                { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' },
                { name: 'SAFE_LAUNCH_FLAG', value: '1' },
            ],
            defaultPermissionModeByTargetKey: { 'backend:claude': 'acceptEdits' as const },
            defaultPersistenceModeByTargetKey: { 'backend:claude': 'persisted' as const },
            compatibilityByTargetKey: { 'backend:claude': true },
            createdAt: 1, updatedAt: 1,
        };

        for (const converted of [
            convertBuiltInProfileToCustom(legacy as never),
            duplicateProfileForEdit(legacy as never, { copySuffix: 'Copy' }),
        ]) {
            expect(converted).toMatchObject({
                v: 2,
                description: 'Keep me',
                extraEnvironmentVariables: [{ name: 'SAFE_LAUNCH_FLAG', value: '1' }],
                defaultPermissionModeByTargetKey: { 'backend:claude': 'acceptEdits' },
                defaultPersistenceModeByTargetKey: { 'backend:claude': 'persisted' },
                compatibilityByTargetKey: { 'backend:claude': true },
            });
            expect(converted.extraEnvironmentVariables).not.toContainEqual(expect.objectContaining({ name: 'ANTHROPIC_BASE_URL' }));
        }
    });
});
