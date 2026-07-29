import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { resolveVisibleBuiltInLaunchProfiles } from './visibleBuiltInLaunchProfiles';

describe('post-demotion built-in launch profile catalog', () => {
    it('shows no provider-like or machine-login built-ins for a fresh account', () => {
        expect(resolveVisibleBuiltInLaunchProfiles({
            lastUsedProfile: null,
            favoriteProfileIds: [],
            profileEnabledById: {},
            secretBindingsByProfileId: {},
        }).map((profile) => profile.id)).toEqual([]);
    });

    it('retains only contracted evidence-backed Azure and Gemini compatibility profiles', () => {
        expect(resolveVisibleBuiltInLaunchProfiles({
            lastUsedProfile: 'azure-openai',
            favoriteProfileIds: ['gemini-api-key'],
            profileEnabledById: { 'gemini-vertex': true, deepseek: true },
            secretBindingsByProfileId: { 'gemini-api-key': { GEMINI_API_KEY: 'secret-a' } },
        }).map((profile) => profile.id).sort()).toEqual([
            'azure-openai', 'gemini-api-key', 'gemini-vertex',
        ]);
    });

    it('does not resurrect a removed provider-like source even when stale evidence remains', () => {
        expect(resolveVisibleBuiltInLaunchProfiles({
            lastUsedProfile: 'deepseek',
            favoriteProfileIds: ['deepseek'],
            profileEnabledById: { deepseek: true },
            secretBindingsByProfileId: { deepseek: { ANTHROPIC_AUTH_TOKEN: 'secret-a' } },
            migration: {
                v: 1,
                completedSources: [{
                    sourceProfileId: 'deepseek',
                    kind: 'connection',
                    connectionId: ProviderConnectionIdSchema.parse('pc_deepseek'),
                    modelSelection: {
                        agentTargetKey: 'agent:claude',
                        providerConnectionId: ProviderConnectionIdSchema.parse('pc_deepseek'),
                        modelId: 'deepseek-chat',
                    },
                }],
                pendingCustomProfileIds: [],
                pendingConflicts: [],
            },
        }).map((profile) => profile.id)).not.toContain('deepseek');
    });
});
