import { describe, it, expect } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { getEnabledAgentIds, isAgentEnabled } from './enabled';

describe('agents/enabled', () => {
    it('enables all agents by default when no explicit backend map is provided', () => {
        const allAgents = ['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'customAcp', 'pi', 'copilot'] as const;
        for (const agentId of allAgents) {
            expect(isAgentEnabled({ agentId, backendEnabledByTargetKey: {} })).toBe(true);
            expect(isAgentEnabled({ agentId, backendEnabledByTargetKey: null })).toBe(true);
            expect(isAgentEnabled({ agentId, backendEnabledByTargetKey: undefined })).toBe(true);
        }
    });

    it('disables agents only when explicitly set to false', () => {
        const cases = [
            {
                agentId: 'gemini' as const,
                backendEnabledByTargetKey: { [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false } as Record<string, boolean>,
                expected: false,
            },
            {
                agentId: 'gemini' as const,
                backendEnabledByTargetKey: { [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: true } as Record<string, boolean>,
                expected: true,
            },
            {
                agentId: 'auggie' as const,
                backendEnabledByTargetKey: { [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'auggie' })]: false } as Record<string, boolean>,
                expected: false,
            },
            {
                agentId: 'auggie' as const,
                backendEnabledByTargetKey: { [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'auggie' })]: true } as Record<string, boolean>,
                expected: true,
            },
        ];
        for (const testCase of cases) {
            expect(
                isAgentEnabled({
                    agentId: testCase.agentId,
                    backendEnabledByTargetKey: testCase.backendEnabledByTargetKey,
                }),
            ).toBe(testCase.expected);
        }
    });

    it('returns enabled agent ids in display order', () => {
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: {} })).toEqual(['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'customAcp', 'pi', 'copilot']);
        expect(getEnabledAgentIds({
            backendEnabledByTargetKey: {
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'auggie' })]: false,
            },
        })).toEqual(['claude', 'codex', 'opencode', 'qwen', 'kimi', 'kilo', 'kiro', 'customAcp', 'pi', 'copilot']);
    });

    it('ignores unknown backend ids in the toggle map', () => {
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: { unknownAgent: false } })).toEqual(['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'customAcp', 'pi', 'copilot']);
    });
});
