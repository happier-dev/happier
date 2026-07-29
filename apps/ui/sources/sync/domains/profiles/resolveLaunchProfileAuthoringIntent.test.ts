import { describe, expect, it } from 'vitest';
import {
    LaunchProfileV2Schema,
    ProviderBoundModelRefSchema,
    ProviderSettingsMigrationStateV1Schema,
    type ProviderSettingsMigrationStateV1,
} from '@happier-dev/protocol';

import { resolveLaunchProfileAuthoringIntent } from './resolveLaunchProfileAuthoringIntent';

const providerRef = ProviderBoundModelRefSchema.parse({
    agentTargetKey: 'agent:claude',
    providerConnectionId: 'pc_deepseek',
    modelId: 'deepseek-chat',
});

function migration(completedSources: ProviderSettingsMigrationStateV1['completedSources']): ProviderSettingsMigrationStateV1 {
    return ProviderSettingsMigrationStateV1Schema.parse({
        v: 1, completedSources, pendingCustomProfileIds: [], migratedAt: 20,
    });
}

describe('resolveLaunchProfileAuthoringIntent', () => {
    it('applies a slim profile preferred agent and exact provider-bound model selection', () => {
        const profile = LaunchProfileV2Schema.parse({
            v: 2, id: 'work', name: 'Work', createdAt: 1, updatedAt: 2,
            preferredAgentTargetKey: 'agent:claude',
            preferredModelSelection: { v: 1, updatedAt: 2, ref: providerRef },
        });
        expect(resolveLaunchProfileAuthoringIntent({ profileId: 'work', profiles: [profile], migration: undefined }))
            .toEqual({
                profileId: 'work',
                preferredAgentTargetKey: 'backend:claude',
                modelSelection: {
                    ...profile.preferredModelSelection,
                    ref: { ...profile.preferredModelSelection!.ref, agentTargetKey: 'backend:claude' },
                },
            });
    });

    it('normalizes placeholders to Default Environment and completed providers to their exact model ref', () => {
        expect(resolveLaunchProfileAuthoringIntent({
            profileId: 'anthropic', profiles: [],
            migration: migration([{ sourceProfileId: 'anthropic', kind: 'default_environment' }]),
        })).toEqual({ profileId: null, preferredAgentTargetKey: null, modelSelection: null });

        expect(resolveLaunchProfileAuthoringIntent({
            profileId: 'deepseek', profiles: [],
            migration: migration([{
                sourceProfileId: 'deepseek', kind: 'connection',
                connectionId: providerRef.providerConnectionId!, sourceRevision: 2,
                modelSelectionOrigin: 'implicit_default', modelSelection: providerRef,
            }]),
        })).toEqual({
            profileId: null,
            preferredAgentTargetKey: 'backend:claude',
            modelSelection: {
                v: 1,
                updatedAt: 20,
                ref: { ...providerRef, agentTargetKey: 'backend:claude' },
            },
        });
    });

    it('keeps retained legacy profiles unchanged and does not recreate a deleted completed connection', () => {
        expect(resolveLaunchProfileAuthoringIntent({ profileId: 'azure-openai', profiles: [], migration: undefined }))
            .toEqual({ profileId: 'azure-openai', preferredAgentTargetKey: null, modelSelection: null });
        const result = resolveLaunchProfileAuthoringIntent({
            profileId: 'deepseek', profiles: [],
            migration: migration([{
                sourceProfileId: 'deepseek', kind: 'connection',
                connectionId: providerRef.providerConnectionId!, sourceRevision: 2,
                modelSelectionOrigin: 'implicit_default', modelSelection: providerRef,
            }]),
        });
        expect(result.modelSelection?.ref.providerConnectionId).toBe('pc_deepseek');
    });

    it('does not promote a pre-provenance DeepSeek outcome into executable authoring intent', () => {
        expect(resolveLaunchProfileAuthoringIntent({
            profileId: 'deepseek', profiles: [],
            migration: migration([{
                sourceProfileId: 'deepseek', kind: 'connection',
                connectionId: providerRef.providerConnectionId!, modelSelection: providerRef,
            }]),
        })).toEqual({
            profileId: 'deepseek',
            preferredAgentTargetKey: null,
            modelSelection: null,
        });
    });

    it('does not recover a pre-provenance DeepSeek selection from a retained slim profile', () => {
        const retained = LaunchProfileV2Schema.parse({
            v: 2,
            id: 'deepseek',
            name: 'DeepSeek',
            preferredAgentTargetKey: 'agent:claude',
            preferredModelSelection: { v: 1, updatedAt: 2, ref: providerRef },
            createdAt: 1,
            updatedAt: 2,
        });

        expect(resolveLaunchProfileAuthoringIntent({
            profileId: 'deepseek',
            profiles: [retained],
            migration: migration([{
                sourceProfileId: 'deepseek',
                kind: 'connection',
                connectionId: providerRef.providerConnectionId!,
                modelSelection: providerRef,
            }]),
        })).toEqual({
            profileId: 'deepseek',
            preferredAgentTargetKey: 'backend:claude',
            modelSelection: null,
        });
    });
});
