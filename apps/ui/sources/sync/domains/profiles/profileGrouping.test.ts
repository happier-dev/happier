import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { AIBackendProfileSchema } from './profileCompatibility';
import { buildProfileGroups, toggleFavoriteProfileId } from './profileGrouping';

function buildCustomProfile(params: {
    id: string;
    name: string;
    compatibility: Record<'claude' | 'codex' | 'gemini', boolean>;
}) {
    return AIBackendProfileSchema.parse({
        id: params.id,
        name: params.name,
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: params.compatibility,
        compatibilityByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: params.compatibility.claude,
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: params.compatibility.codex,
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: params.compatibility.gemini,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    });
}

describe('toggleFavoriteProfileId', () => {
    it('adds the profile id to the front when missing', () => {
        expect(toggleFavoriteProfileId([], 'anthropic')).toEqual(['anthropic']);
    });

    it('removes the profile id when already present', () => {
        expect(toggleFavoriteProfileId(['anthropic', 'openai'], 'anthropic')).toEqual(['openai']);
    });

    it('supports favoriting the default environment (empty profile id)', () => {
        expect(toggleFavoriteProfileId(['anthropic'], '')).toEqual(['', 'anthropic']);
        expect(toggleFavoriteProfileId(['', 'anthropic'], '')).toEqual(['anthropic']);
    });
});

describe('buildProfileGroups', () => {
    it('filters favoriteIds to resolvable profiles (preserves default environment favorite)', () => {
        const customProfiles = [
            buildCustomProfile({
                id: 'custom-profile',
                name: 'Custom Profile',
                compatibility: { claude: true, codex: true, gemini: true },
            }),
        ];

        const groups = buildProfileGroups({
            customProfiles,
            favoriteProfileIds: ['', 'anthropic', 'missing-profile', 'custom-profile'],
        });

        expect(groups.favoriteIds.has('')).toBe(true);
        expect(groups.favoriteIds.has('anthropic')).toBe(true);
        expect(groups.favoriteIds.has('custom-profile')).toBe(true);
        expect(groups.favoriteIds.has('missing-profile')).toBe(false);
    });

    it('hides profiles that are incompatible with all enabled agents', () => {
        const customProfiles = [
            buildCustomProfile({
                id: 'custom-gemini-only',
                name: 'Gemini Only',
                compatibility: { claude: false, codex: false, gemini: true },
            }),
        ];

        const groups = buildProfileGroups({
            customProfiles,
            favoriteProfileIds: ['gemini', 'custom-gemini-only'],
            enabledAgentIds: ['claude', 'codex'],
        });

        expect(groups.builtInProfiles.some((p) => p.id === 'gemini')).toBe(false);
        expect(groups.builtInProfiles.some((p) => p.id === 'gemini-api-key')).toBe(false);
        expect(groups.builtInProfiles.some((p) => p.id === 'gemini-vertex')).toBe(false);
        expect(groups.favoriteProfiles.some((p) => p.id === 'custom-gemini-only')).toBe(false);
        expect(groups.customProfiles.some((p) => p.id === 'custom-gemini-only')).toBe(false);
    });

    it('hides disabled profiles from picker groups', () => {
        const customProfiles = [
            buildCustomProfile({
                id: 'custom-profile',
                name: 'Custom Profile',
                compatibility: { claude: true, codex: true, gemini: true },
            }),
        ];

        const groups = buildProfileGroups({
            customProfiles,
            favoriteProfileIds: ['anthropic', 'custom-profile'],
            profileEnabledById: {
                anthropic: false,
                'custom-profile': false,
            },
        });

        expect(groups.favoriteIds.has('anthropic')).toBe(false);
        expect(groups.favoriteIds.has('custom-profile')).toBe(false);
        expect(groups.favoriteProfiles.map((p) => p.id)).toEqual([]);
        expect(groups.customProfiles.map((p) => p.id)).not.toContain('custom-profile');
        expect(groups.builtInProfiles.map((p) => p.id)).not.toContain('anthropic');
    });

    it('can include disabled profiles for management surfaces', () => {
        const customProfiles = [
            buildCustomProfile({
                id: 'custom-profile',
                name: 'Custom Profile',
                compatibility: { claude: true, codex: true, gemini: true },
            }),
        ];

        const groups = buildProfileGroups({
            customProfiles,
            favoriteProfileIds: ['anthropic', 'custom-profile'],
            profileEnabledById: {
                anthropic: false,
                'custom-profile': false,
            },
            includeDisabledProfiles: true,
        });

        expect(groups.favoriteIds.has('anthropic')).toBe(true);
        expect(groups.favoriteIds.has('custom-profile')).toBe(true);
        expect(groups.favoriteProfiles.map((p) => p.id)).toEqual(['anthropic', 'custom-profile']);
    });
});
