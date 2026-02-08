import { describe, it, expect } from 'vitest';

import { getEnabledAgentIds, isAgentEnabled } from './enabled';

describe('agents/enabled', () => {
    it('enables stable agents regardless of experiments', () => {
        const stableAgents = ['claude', 'codex', 'opencode'] as const;
        for (const agentId of stableAgents) {
            expect(isAgentEnabled({ agentId, experiments: false, experimentalAgents: {} })).toBe(true);
            expect(isAgentEnabled({ agentId, experiments: true, experimentalAgents: {} })).toBe(true);
        }
    });

    it('gates experimental agents behind experiments + per-agent toggle', () => {
        const cases = [
            { agentId: 'gemini' as const, experiments: false, experimentalAgents: { gemini: true }, expected: false },
            { agentId: 'gemini' as const, experiments: true, experimentalAgents: { gemini: false }, expected: false },
            { agentId: 'gemini' as const, experiments: true, experimentalAgents: { gemini: true }, expected: true },
            { agentId: 'auggie' as const, experiments: false, experimentalAgents: { auggie: true }, expected: false },
            { agentId: 'auggie' as const, experiments: true, experimentalAgents: { auggie: false }, expected: false },
            { agentId: 'auggie' as const, experiments: true, experimentalAgents: { auggie: true }, expected: true },
        ];
        for (const testCase of cases) {
            expect(
                isAgentEnabled({
                    agentId: testCase.agentId,
                    experiments: testCase.experiments,
                    experimentalAgents: testCase.experimentalAgents,
                }),
            ).toBe(testCase.expected);
        }
    });

    it('treats sparse or missing experimental maps as disabled for experimental agents', () => {
        expect(isAgentEnabled({ agentId: 'gemini', experiments: true, experimentalAgents: {} })).toBe(false);
        expect(isAgentEnabled({ agentId: 'gemini', experiments: true, experimentalAgents: null })).toBe(false);
        expect(isAgentEnabled({ agentId: 'gemini', experiments: true, experimentalAgents: undefined })).toBe(false);
    });

    it('returns enabled agent ids in display order', () => {
        expect(getEnabledAgentIds({ experiments: false, experimentalAgents: { gemini: true, auggie: true } })).toEqual(['claude', 'codex', 'opencode']);
        expect(getEnabledAgentIds({ experiments: true, experimentalAgents: { gemini: true, auggie: true } })).toEqual(['claude', 'codex', 'opencode', 'gemini', 'auggie']);
    });

    it('ignores unknown experimental toggles', () => {
        expect(getEnabledAgentIds({ experiments: true, experimentalAgents: { unknownAgent: true } })).toEqual(['claude', 'codex', 'opencode']);
    });
});
