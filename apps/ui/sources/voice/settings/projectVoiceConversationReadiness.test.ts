import { describe, expect, it } from 'vitest';
import { settingsParse } from '@/sync/domains/settings/settings';
import { EMPTY_MACHINE_AGENTS } from '@/agents/machineAgents/machineAgentInventoryStore';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveLocalVoiceAdapterSettingsFromVoice } from '@/voice/local/localVoiceSettings';
import { selectVoiceProviderOption } from '@/voice/registry/providerSelection';
import { resolveVoiceProviderAvailability } from './resolveVoiceProviderAvailability';
import { projectVoiceConversationAgentSelection, projectVoiceConversationReadiness } from './projectVoiceConversationReadiness';

function inputs(settings: ReturnType<typeof settingsParse>) {
    return { registry: createDefaultVoiceProviderRegistry(), settings, connectedPurposes: null, platform: 'web' as const,
        availability: resolveVoiceProviderAvailability({ happierVoiceSupported: true, platformOs: 'web' }),
        happierVoiceSupported: true, executionMachineId: 'machine-1', executionMachineSelectedId: 'machine-1',
        executionMachineOnline: true, executionMachineSelectionKind: 'resolved' as const,
        voiceAgentAvailability: 'available' as const,
        agentSelection: projectVoiceConversationAgentSelection({ voice: settings.voice, presentation: 'gallery', localAdapter: resolveLocalVoiceAdapterSettingsFromVoice(settings.voice),
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey, rememberedAgent: { lastUsedAgent: 'claude' } }),
        observedAgents: EMPTY_MACHINE_AGENTS, agentContext: { serverId: 'server-1', machineId: 'machine-1' },
        connectedServices: { accountProfileConnectedServicesV2: [], labelsByKey: {}, accountGroupsEnabled: false } };
}

describe('shared conversation readiness composition', () => {
    it('uses the initialized selected Run over unobserved Agent inventory, and rejects a different Home', () => {
        const settings = settingsParse({ voice: { providerId: 'local_conversation', providers: {
            local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent',
                agent: { agentSource: 'agent', agentId: 'claude' } } },
        } } });
        const input = inputs(settings);
        expect(input.agentSelection.selectedAgent).not.toBeNull();
        expect(projectVoiceConversationReadiness({ ...input, presentation: 'gallery' }).localFacts.thinkReadiness.code).toBe('runtime_unknown');
        const activeRuntime = { serverId: 'server-1', machineId: 'machine-1', ready: true,
            backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' } };
        const ready = projectVoiceConversationReadiness({ ...input, presentation: 'gallery',
            agentContext: { ...input.agentContext, activeRuntime } });
        expect(ready.localFacts.thinkReadiness.status).toBe('ready');
        expect(ready.localFacts.thinkReadiness.selectedAgent?.title).toBeTruthy();
        expect(projectVoiceConversationReadiness({ ...input, presentation: 'inspection',
            agentContext: { ...input.agentContext, activeRuntime: { ...activeRuntime, serverId: 'different-home' } },
        }).localFacts.thinkReadiness.code).toBe('runtime_unknown');
    });

    it('preserves the hosted-disabled outcome in gallery and semantic inspection', () => {
        const base = inputs(settingsParse({}));
        const entry = base.registry.list().find(candidate => candidate.selectionOptions?.some(option => option.modeId === 'happier'))!;
        const option = entry.selectionOptions!.find(candidate => candidate.modeId === 'happier')!;
        const voice = selectVoiceProviderOption(base.settings.voice, base.registry, entry.providerId, option.id)!;
        const settings = { ...base.settings, voice };
        const input = { ...inputs(settings), happierVoiceSupported: false,
            availability: resolveVoiceProviderAvailability({ happierVoiceSupported: false, platformOs: 'web' }) };
        const gallery = projectVoiceConversationReadiness({ ...input, presentation: 'gallery' });
        const semantic = projectVoiceConversationReadiness({ ...input, presentation: 'inspection' });
        expect(gallery.selectedProviderReadiness).toMatchObject({ status: 'unavailable', code: 'server_feature_disabled' });
        expect(semantic.readiness).toEqual(gallery.selectedProviderReadiness);
    });
});
