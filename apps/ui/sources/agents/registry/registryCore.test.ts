import { describe, it, expect } from 'vitest';

import { getAgentModelConfig } from '@happier-dev/agents';

import {
    resolveAgentIdFromCliDetectKey,
    resolveAgentIdFromConnectedServiceId,
    resolveAgentIdFromFlavor,
    getAgentCore,
    AGENT_IDS,
} from './registryCore';

describe('agents/registryCore', () => {
    it('exposes a stable list of agent ids', () => {
        expect(Array.isArray(AGENT_IDS)).toBe(true);
        expect(AGENT_IDS.length).toBeGreaterThan(0);
    });

    it('resolves known flavors and aliases to canonical agent ids', () => {
        expect(resolveAgentIdFromFlavor('claude')).toBe('claude');
        expect(resolveAgentIdFromFlavor('codex')).toBe('codex');
        expect(resolveAgentIdFromFlavor('opencode')).toBe('opencode');
        expect(resolveAgentIdFromFlavor('gemini')).toBe('gemini');

        // Common Codex aliases found in persisted session metadata.
        expect(resolveAgentIdFromFlavor('openai')).toBe('codex');
        expect(resolveAgentIdFromFlavor('gpt')).toBe('codex');
    });

    it('returns null for unknown flavor strings', () => {
        expect(resolveAgentIdFromFlavor('unknown')).toBeNull();
        expect(resolveAgentIdFromFlavor('')).toBeNull();
        expect(resolveAgentIdFromFlavor(null)).toBeNull();
        expect(resolveAgentIdFromFlavor(undefined)).toBeNull();
    });

    it('resolves agent ids from cli detect keys and handles malformed values', () => {
        const cases = [
            { detectKey: 'claude', expected: 'claude' },
            { detectKey: 'codex', expected: 'codex' },
            { detectKey: 'opencode', expected: 'opencode' },
            { detectKey: '  ', expected: null },
            { detectKey: 'unknown', expected: null },
            { detectKey: null, expected: null },
            { detectKey: undefined, expected: null },
        ] as const;
        for (const testCase of cases) {
            expect(resolveAgentIdFromCliDetectKey(testCase.detectKey)).toBe(testCase.expected);
        }
    });

    it('resolves connected service ids in a case-insensitive way', () => {
        expect(resolveAgentIdFromConnectedServiceId('anthropic')).toBe('claude');
        expect(resolveAgentIdFromConnectedServiceId('Anthropic')).toBe('claude');
        expect(resolveAgentIdFromConnectedServiceId('openai')).toBe('codex');
        expect(resolveAgentIdFromConnectedServiceId('')).toBeNull();
        expect(resolveAgentIdFromConnectedServiceId(null)).toBeNull();
        expect(resolveAgentIdFromConnectedServiceId(undefined)).toBeNull();
    });

    it('provides core config for known agents', () => {
        const claude = getAgentCore('claude');
        expect(claude.id).toBe('claude');
        expect(claude.cli.detectKey).toBeTruthy();
    });

    it('provides core config for kilo', () => {
        const kilo = getAgentCore('kilo');
        expect(kilo.id).toBe('kilo');
        expect(kilo.cli.detectKey).toBeTruthy();
    });

    it('provides core config for pi', () => {
        const pi = getAgentCore('pi');
        expect(pi.id).toBe('pi');
        expect(pi.cli.detectKey).toBeTruthy();
    });

    it('reads model selection config from @happier-dev/agents', () => {
        const claude = getAgentModelConfig('claude');
        expect(claude.supportsSelection).toBe(true);
        expect(claude.nonAcpApplyScope).toBe('next_prompt');
        expect(claude.supportsFreeform).toBe(true);
        expect(claude.allowedModes.length).toBeGreaterThan(0);

        // ACP backends with supported model probing + overrides
        const codex = getAgentModelConfig('codex');
        expect(codex.supportsSelection).toBe(true);

        const opencode = getAgentModelConfig('opencode');
        expect(opencode.supportsSelection).toBe(true);

        const kilo = getAgentModelConfig('kilo');
        expect(kilo.supportsSelection).toBe(true);

        const auggie = getAgentModelConfig('auggie');
        expect(auggie.supportsSelection).toBe(true);

        const qwen = getAgentModelConfig('qwen');
        expect(qwen.supportsSelection).toBe(true);

        const kimi = getAgentModelConfig('kimi');
        expect(kimi.supportsSelection).toBe(true);

        const pi = getAgentModelConfig('pi');
        expect(pi.supportsSelection).toBe(true);
    });
});
