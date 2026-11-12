import { describe, expect, it } from 'vitest';
import { applyVoiceAgentSelectionV1, resolveVoiceAgentCatalogSelectionV1, type VoiceAgentCatalogEntryV1 } from './voiceAgentSelection.js';
import { createVoiceSettingsOwner } from './voiceSettings.js';

describe('Voice catalog selection', () => {
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
