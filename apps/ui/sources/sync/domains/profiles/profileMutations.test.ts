import { describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'profile-id',
}));

import { createEmptyCustomProfile } from './profileMutations';

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
