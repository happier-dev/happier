import { describe, it, expect } from 'vitest';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import { getEnabledAgentIds, isAgentEnabled } from './enabled';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';

/** Canonical catalog order, minus Agents the catalog marks unselectable. */
const SELECTABLE_AGENT_IDS_IN_DISPLAY_ORDER = [
    'claude', 'codex', 'opencode', 'antigravity', 'gemini', 'grok', 'auggie', 'qwen', 'kimi',
    'kilo', 'kiro', 'devin', 'fx', 'droid', 'cursor', 'ohMyPi', 'pi', 'copilot',
] as const;
const AVAILABLE_SELECTABLE_AGENT_IDS = SELECTABLE_AGENT_IDS_IN_DISPLAY_ORDER.filter((id) => CANONICAL_AGENT_IDS.includes(id));

describe('agents/enabled', () => {
    it.runIf(CANONICAL_AGENT_IDS.includes('antigravity'))('keeps a live-negotiated agent enabled without static model facts', () => {
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: {} })).toContain('antigravity');
    });

    it('enables all agents by default when no explicit backend map is provided', () => {
        const allAgents = ['claude', 'codex', 'opencode', 'antigravity', 'gemini', 'grok', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'cursor', 'ohMyPi', 'pi', 'copilot'] as const;
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

    // Antigravity's released concrete backend ids are declared by
    // `packages/plugins/antigravity/src/agent/definition.ts`
    // (`enablementCompatibilityBackendIds`) and reach this reader through the
    // generated bundled Agent definitions. Until that projection is
    // regenerated, this expectation and the `antigravity`-disabled case below
    // pin the source truth rather than the stale generated artifact.
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
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: {} })).toEqual(AVAILABLE_SELECTABLE_AGENT_IDS);
        expect(getEnabledAgentIds({
            backendEnabledByTargetKey: {
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: false,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' })]: false,
                [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'antigravity-localharness' })]: false,
            },
        })).toEqual(AVAILABLE_SELECTABLE_AGENT_IDS.filter(
            (agentId) => agentId !== 'gemini' && agentId !== 'auggie' && agentId !== 'antigravity',
        ));
    });

    it('ignores unknown backend ids in the toggle map', () => {
        expect(getEnabledAgentIds({ backendEnabledByTargetKey: { unknownAgent: false } })).toEqual(AVAILABLE_SELECTABLE_AGENT_IDS);
    });
});
