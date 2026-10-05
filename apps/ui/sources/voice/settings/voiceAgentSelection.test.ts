import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { applyVoiceAgentSelection, type VoiceAgentSelectionChoice } from './voiceAgentSelection';

const externalChoice = {
    kind: 'catalog',
    entry: {
        agentId: 'external-registry-id',
        backendTargetKey: 'agent:acme.voice/agents/conversation',
        identity: { pluginId: 'acme.voice', localId: 'agents/conversation' },
        projectionGeneration: 7,
        isBuiltIn: false,
    },
} satisfies VoiceAgentSelectionChoice;

describe('atomic Voice Agent selection', () => {
    it('persists the exact external catalog tuple and replaces it completely for a bundled Agent', () => {
        const external = applyVoiceAgentSelection(voiceSettingsDefaults, externalChoice);
        const persisted = settingsParse({ voice: external }).voice;
        expect(readLocalConversationVoiceSettings(persisted).agent).toMatchObject({
            agentId: 'external-registry-id',
            agentTargetKey: 'agent:acme.voice/agents/conversation',
            agentIdentity: { pluginId: 'acme.voice', localId: 'agents/conversation' },
            agentProjectionGeneration: 7,
        });
        const bundled = applyVoiceAgentSelection(persisted, {
            kind: 'catalog',
            entry: {
                agentId: 'codex', backendTargetKey: 'agent:happier.agent.codex/codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                projectionGeneration: 8, isBuiltIn: true,
            },
        });
        expect(readLocalConversationVoiceSettings(bundled).agent).toMatchObject({
            agentId: 'codex', agentTargetKey: 'agent:happier.agent.codex/codex',
            agentIdentity: null, agentProjectionGeneration: null,
        });
    });

    it('keeps unchanged custom selections exact but clears the tuple when the normalized id changes', () => {
        const external = applyVoiceAgentSelection(voiceSettingsDefaults, externalChoice);
        expect(applyVoiceAgentSelection(external, { kind: 'custom', agentId: '  external-registry-id  ' })).toBe(external);
        expect(applyVoiceAgentSelection(external, { kind: 'custom', agentId: '  ' })).toBe(external);
        const changed = applyVoiceAgentSelection(external, { kind: 'custom', agentId: '  claude  ' });
        expect(readLocalConversationVoiceSettings(changed).agent).toMatchObject({
            agentId: 'claude', agentTargetKey: null, agentIdentity: null, agentProjectionGeneration: null,
        });
    });
});
