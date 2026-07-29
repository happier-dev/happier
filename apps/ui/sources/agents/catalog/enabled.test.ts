import { describe, it, expect } from 'vitest';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import { getEnabledAgentIds, isAgentEnabled } from './enabled';

describe('agents/enabled', () => {
    it('enables all agents by default when no explicit backend map is provided', () => {
        const allAgents = ['claude', 'codex', 'opencode', 'antigravity', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'pi', 'ohMyPi', 'copilot'] as const;
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
                backendEnabledByTargetKey: { [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: false } as Record<string, boolean>,
                expected: false,
            },
            {
                agentId: 'gemini' as const,
                backendEnabledByTargetKey: { [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: true } as Record<string, boolean>,
                expected: true,
            },
            {
                agentId: 'auggie' as const,
                backendEnabledByTargetKey: { [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' })]: false } as Record<string, boolean>,
                expected: false,
            },
            {
                agentId: 'auggie' as const,
                backendEnabledByTargetKey: { [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' })]: true } as Record<string, boolean>,
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

    it('uses a provider settings backend target key for providers that collapse onto a non-provider backend id', () => {
        expect(isAgentEnabled({
            agentId: 'antigravity',
            backendEnabledByTargetKey: {
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-localharness' })]: false,
            } as Record<string, boolean>,
        })).toBe(false);
        expect(isAgentEnabled({
            agentId: 'antigravity',
            backendEnabledByTargetKey: {
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-localharness' })]: true,
            } as Record<string, boolean>,
        })).toBe(true);
    });

    it('lets the canonical Antigravity target key override legacy concrete target keys', () => {
        expect(isAgentEnabled({
            agentId: 'antigravity',
            backendEnabledByTargetKey: {
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-localharness' })]: false,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-terminal' })]: false,
            } as Record<string, boolean>,
        })).toBe(true);

        expect(isAgentEnabled({
            agentId: 'antigravity',
            backendEnabledByTargetKey: {
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity' })]: false,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-localharness' })]: true,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-terminal' })]: true,
            } as Record<string, boolean>,
        })).toBe(false);
    });

    it('returns enabled agent ids in display order', () => {
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: {} })).toEqual(['claude', 'codex', 'opencode', 'antigravity', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'cursor', 'ohMyPi', 'pi', 'copilot']);
        expect(getEnabledAgentIds({
            backendEnabledByTargetKey: {
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: false,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' })]: false,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-localharness' })]: false,
            },
        })).toEqual(['claude', 'codex', 'opencode', 'qwen', 'kimi', 'kilo', 'kiro', 'cursor', 'ohMyPi', 'pi', 'copilot']);
    });

    it('ignores unknown backend ids in the toggle map', () => {
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: { unknownAgent: false } })).toEqual(['claude', 'codex', 'opencode', 'antigravity', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'cursor', 'ohMyPi', 'pi', 'copilot']);
    });
});
