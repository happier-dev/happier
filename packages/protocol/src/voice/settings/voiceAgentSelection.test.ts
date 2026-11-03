import { describe, expect, it } from 'vitest';
import { resolveVoiceAgentCatalogSelectionV1, type VoiceAgentCatalogEntryV1 } from './voiceAgentSelection.js';

describe('Voice catalog selection', () => {
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
