import { describe, it, expect } from 'vitest';

import { getEnabledAgentIds, isAgentEnabled } from './enabled';

describe('agents/enabled', () => {
    it('enables all agents by default when no explicit backend map is provided', () => {
        const allAgents = ['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'pi'] as const;
        for (const agentId of allAgents) {
            expect(isAgentEnabled({ agentId, backendEnabledById: {} })).toBe(true);
            expect(isAgentEnabled({ agentId, backendEnabledById: null })).toBe(true);
            expect(isAgentEnabled({ agentId, backendEnabledById: undefined })).toBe(true);
        }
    });

    it('disables agents only when explicitly set to false', () => {
        const cases = [
            { agentId: 'gemini' as const, backendEnabledById: { gemini: false } as Record<string, boolean>, expected: false },
            { agentId: 'gemini' as const, backendEnabledById: { gemini: true } as Record<string, boolean>, expected: true },
            { agentId: 'auggie' as const, backendEnabledById: { auggie: false } as Record<string, boolean>, expected: false },
            { agentId: 'auggie' as const, backendEnabledById: { auggie: true } as Record<string, boolean>, expected: true },
        ];
        for (const testCase of cases) {
            expect(
                isAgentEnabled({
                    agentId: testCase.agentId,
                    backendEnabledById: testCase.backendEnabledById,
                }),
            ).toBe(testCase.expected);
        }
    });

    it('returns enabled agent ids in display order', () => {
        expect(getEnabledAgentIds({ backendEnabledById: {} })).toEqual(['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'pi']);
        expect(getEnabledAgentIds({ backendEnabledById: { gemini: false, auggie: false } })).toEqual(['claude', 'codex', 'opencode', 'qwen', 'kimi', 'kilo', 'pi']);
    });

    it('ignores unknown backend ids in the toggle map', () => {
        expect(getEnabledAgentIds({ backendEnabledById: { unknownAgent: false } })).toEqual(['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'pi']);
    });
});
