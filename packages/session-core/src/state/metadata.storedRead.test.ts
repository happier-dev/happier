import { describe, expect, it } from 'vitest';

import { MetadataSchema } from './metadata.js';

describe('stored Session metadata', () => {
    it('retains native categories and grouped choices in both config and model catalogs', () => {
        const option = { id: ' opaque/control= ', name: ' Native name ', description: ' Native description ', category: 'thought_level', type: 'select', currentValue: 'high',
            options: [{ value: 'high', name: ' High ' }], groups: [{ id: ' group/+ ', name: ' Group ', options: [{ value: 'high', name: ' High ' }] }] };
        const config = { v: 1, agentId: 'fx', updatedAt: 1, modelConfigOptionId: ' native/model= ', configOptions: [option] };
        const models = { v: 1, agentId: 'fx', updatedAt: 1, currentModelId: 'native', availableModels: [{ id: 'native', name: 'Native', modelOptions: [option] }] };
        const parsed = MetadataSchema.parse({ path: '/repo', host: 'work', sessionConfigOptionsV1: config, acpConfigOptionsV1: config, sessionModelsV1: models, acpSessionModelsV1: models });
        expect(parsed.sessionConfigOptionsV1).toEqual(config);
        expect(parsed.acpConfigOptionsV1).toEqual(config);
        expect(parsed.sessionModelsV1).toEqual(models);
        expect(parsed.acpSessionModelsV1).toEqual(models);
    });

    it('projects known nested fields while preserving the root native extension carrier', () => {
        const source = { kind: 'discussion', serverId: 'server-a', discussionId: 'discussion-a', messageIds: ['message-a'] };
        const native = { futureNativeContext: { retained: 'opaque' } };
        const runtimeDescriptorV1 = { v: 1, agentId: 'claude', agent: { providerSessionId: 'native-session',
            nativeRecovery: { cursor: 'retained' }, agentExtra: { owner: 'claude', schemaId: 'recovery', v: 1, native: { retained: true } } } };
        const agentRuntimeFacetsV1 = { v: 1, transcriptSource: { supported: true, nativeCursor: 'retained' }, nativeFacet: { retained: true } };
        const sessionConfigOptionOverridesV1 = { v: 1, updatedAt: 1, native: true,
            overrides: { reasoning: { updatedAt: 1, value: 'high', native: { retained: true } } } };
        const parsed = MetadataSchema.parse({ path: '/repo', host: 'work', native,
            runtimeDescriptorV1,
            agentRuntimeFacetsV1,
            sessionConfigOptionOverridesV1,
            placementOrigin: { kind: 'machine_pool', poolId: '11111111-1111-4111-8111-111111111111', retired: true },
            sessionModesV2: { v: 2, agentId: 'claude', updatedAt: 1, currentModeId: 'default', retired: true,
                availableModes: [{ id: 'default', name: 'Default', retired: true }] },
            forkVisualsV1: { v: 1, copies: [], retired: true },
            sessionInitialPromptV1: { v: 1, text: 'Follow up', mode: 'append', createdAtMs: 1,
                source: { ...source, retired: true } },
        });

        expect(parsed.native).toEqual(native);
        expect(parsed.runtimeDescriptorV1).toEqual(runtimeDescriptorV1);
        expect(parsed.agentRuntimeFacetsV1).toEqual(agentRuntimeFacetsV1);
        expect(parsed.sessionConfigOptionOverridesV1).toEqual(sessionConfigOptionOverridesV1);
        expect(parsed.placementOrigin).toEqual({ kind: 'machine_pool', poolId: '11111111-1111-4111-8111-111111111111' });
        expect(parsed.sessionModesV2).toEqual({ v: 2, agentId: 'claude', updatedAt: 1, currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }] });
        expect(parsed.forkVisualsV1).toEqual({ v: 1, copies: [] });
        expect(parsed.sessionInitialPromptV1?.source).toEqual(source);
        expect(MetadataSchema.safeParse({ path: '/repo', host: 'work',
            placementOrigin: { kind: 'machine_pool', poolId: 'invalid', retired: true },
        }).success).toBe(false);
        expect(MetadataSchema.parse({ path: '/repo', host: 'work',
            sessionInitialPromptV1: { v: 1, text: 'Follow up', mode: 'append', createdAtMs: 1,
                source: { ...source, messageIds: [], retired: true } },
        }).sessionInitialPromptV1).toBeUndefined();
    });
});
