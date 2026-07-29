import { describe, expect, it, vi } from 'vitest';

vi.mock('@/agents/registry/generatedBundledPluginEntries.sessionAgentBehaviors', () => ({
    BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIOR_DESCRIPTORS: {},
    BUNDLED_CANONICAL_AGENT_SESSION_BEHAVIORS: {
        claude: {
            participants: {
                deriveSnapshot: () => {
                    throw new Error('broken generated descriptor adapter');
                },
            },
            subagents: {
                deriveSubagents: () => {
                    throw new Error('broken generated descriptor adapter');
                },
            },
        },
    },
}));

describe('session provider behavior registry fail-closed handling', () => {
    it('returns neutral results when generated behavior adapters throw', async () => {
        const module = await import('./sessionProviderBehaviorRegistry');

        expect(module.deriveProviderParticipantSnapshot({
            flavor: 'claude',
            messages: [],
        })).toEqual({});
        expect(module.deriveProviderSessionSubagents({
            flavor: 'claude',
            messages: [],
        })).toEqual([]);
    });
});
