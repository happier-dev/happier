import { describe, expect, it } from 'vitest';
import { applyVoiceAgentSelectionV1, resolveVoiceAgentCatalogSelectionV1, type VoiceAgentCatalogEntryV1 } from './voiceAgentSelection.js';
import { createVoiceSettingsOwner } from './voiceSettings.js';
import { projectVoiceAgentConnectedServices } from './localConversation.js';

describe('Voice catalog selection', () => {
    const codexService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const codexAccount = { source: 'team_resource', resourceId: 'codex-account-offering', deliveryMode: 'brokered' } as const;
    const codexBindings = { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': codexAccount } } as const;
    const codex = { agentId: 'codex', backendTargetKey: 'agent:happier.agent.codex/codex',
        identity: null, projectionGeneration: null, isBuiltIn: true } satisfies VoiceAgentCatalogEntryV1;
    const claude = { ...codex, agentId: 'claude', backendTargetKey: 'agent:happier.agent.claude/claude' };

    it('does not turn the outgoing Agent’s Team offering into a native model on switch or return', () => {
        const owner = createVoiceSettingsOwner({ bundledContributions: [] });
        const voice = owner.voiceSettingsParse({});
        const config = owner.readLocalConversationVoiceSettings(voice);
        const modelId = 'muse-spark-1.3-contributor';
        const model = { kind: 'team_credential_provider_model', teamId: 'qa-team', resourceId: 'qa-offering',
            expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey: codex.backendTargetKey, modelId } as const;
        const selected = owner.writeLocalConversationVoiceSettings(voice, { ...config, agent: { ...config.agent,
            agentSource: 'agent', agentId: codex.agentId, agentTargetKey: codex.backendTargetKey,
            connectedServices: codexBindings, chatModelSource: 'custom', chatModelId: modelId, chatModelSelection: model,
        } });

        expect(owner.readLocalConversationVoiceSettings(applyVoiceAgentSelectionV1(selected,
            { kind: 'catalog', entry: codex }, owner)).agent).toMatchObject({
            connectedServices: codexBindings, chatModelId: modelId, chatModelSelection: model,
        });
        const switched = applyVoiceAgentSelectionV1(selected, { kind: 'catalog', entry: claude }, owner);
        const returned = applyVoiceAgentSelectionV1(switched, { kind: 'catalog', entry: codex }, owner);
        for (const [selection, target] of [[switched, claude], [returned, codex]] as const) {
            const agent = owner.readLocalConversationVoiceSettings(owner.voiceSettingsParse(selection)).agent;
            expect(agent).toMatchObject({ agentSource: 'agent', agentId: target.agentId,
                agentTargetKey: target.backendTargetKey, chatModelId: 'default', chatModelSelection: null });
            expect(agent.connectedServices).toBeUndefined();
        }
    });

    it('projects an old unscoped binding map through the destination Agent’s declared services', () => {
        const owner = createVoiceSettingsOwner({ bundledContributions: [] });
        const voice = owner.voiceSettingsParse({});
        const config = owner.readLocalConversationVoiceSettings(voice);
        const stale = owner.writeLocalConversationVoiceSettings(voice, { ...config, agent: { ...config.agent,
            agentSource: 'agent', agentId: claude.agentId, agentTargetKey: claude.backendTargetKey,
            connectedServices: codexBindings, chatModelSource: 'custom', chatModelId: 'muse-spark-1.3-contributor',
        } });
        const storedAgent = owner.readLocalConversationVoiceSettings(owner.voiceSettingsParse(
            JSON.parse(JSON.stringify(stale)))).agent;
        const claudeService = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } };
        expect(projectVoiceAgentConnectedServices(storedAgent, [claudeService])).toBeUndefined();
        expect(projectVoiceAgentConnectedServices(storedAgent, [{ service: codexService }])).toEqual(codexBindings);
        const mixed = { ...storedAgent, connectedServices: { v: 2, bindingsByServiceId: {
            ...codexBindings.bindingsByServiceId, 'happier.agent.claude/claude-subscription': { source: 'native' },
        } } } as const;
        expect(projectVoiceAgentConnectedServices(mixed, [claudeService])).toEqual({
            v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'native' } },
        });
    });

    it('retains exact Team role choices through settings transport and clears them when changing Agent', () => {
        const owner = createVoiceSettingsOwner({ bundledContributions: [] });
        const team = { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'muse-resource',
            expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'muse-fast' } as const;
        const voice = owner.voiceSettingsParse({});
        const config = owner.readLocalConversationVoiceSettings(voice);
        const selected = owner.writeLocalConversationVoiceSettings(voice, { ...config, agent: { ...config.agent,
            agentId: 'codex', agentTargetKey: team.agentTargetKey,
            chatModelSelection: team, commitModelSelection: team,
        } });
        const restored = owner.voiceSettingsParse(JSON.parse(JSON.stringify(selected)));
        expect(owner.readLocalConversationVoiceSettings(restored).agent).toMatchObject({ chatModelSelection: team, commitModelSelection: team });
        const changed = applyVoiceAgentSelectionV1(restored, { kind: 'custom', agentId: 'claude' }, owner);
        expect(owner.readLocalConversationVoiceSettings(changed).agent).toMatchObject({ chatModelSelection: null, commitModelSelection: null });
    });
    const identity = { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' };
    const configured = { agentId: 'custom-acp',
        backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:qa-foldseed-acp',
        identity, projectionGeneration: 1, isBuiltIn: false, enabled: true } satisfies VoiceAgentCatalogEntryV1;

    it('preserves the configured definition and refuses its abstract presentation identity', () => {
        const abstract = { ...configured, backendTargetKey: null };
        expect(resolveVoiceAgentCatalogSelectionV1([configured], configured.backendTargetKey)).toBe(configured);
        expect(resolveVoiceAgentCatalogSelectionV1([abstract], 'custom-acp')).toBeNull();
    });

    it('matches equivalent catalog target spellings without selecting a different configured definition', () => {
        const other = { ...configured, backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:other' };
        expect(resolveVoiceAgentCatalogSelectionV1([other, configured], 'backend:qa-foldseed-acp:configured:qa-foldseed-acp')).toBe(configured);
        expect(resolveVoiceAgentCatalogSelectionV1([other, configured], 'custom-acp')).toBeNull();
    });
});
