import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../manifest.js';
import {
    isConnectedServiceAccountGroupConfigurationSupported,
    isConnectedServiceRuntimeFallbackSupported,
    resolveConnectedServiceRuntimeFallbackCapability,
    supportsAgentConnectedServiceSessionAuthSwitchTransition,
} from './runtimeFallbackCapability.js';

describe('runtime fallback capability', () => {
    it('respects service-scoped transition support for individual agents', () => {
        expect(supportsAgentConnectedServiceSessionAuthSwitchTransition({
            agentCore: AGENTS_CORE.codex,
            serviceId: 'openai-codex',
            transition: 'connected_to_connected',
        })).toBe(true);

        expect(supportsAgentConnectedServiceSessionAuthSwitchTransition({
            agentCore: AGENTS_CORE.codex,
            serviceId: 'openai',
            transition: 'connected_to_connected',
        })).toBe(false);
    });

    it('admits Gemini same-group runtime fallback through its explicit declaration', () => {
        const gemini = resolveConnectedServiceRuntimeFallbackCapability('gemini');

        expect(gemini.groupConfigurationSupported).toBe(true);
        expect(gemini.runtimeFallbackSupported).toBe(true);
        expect(gemini.groupConfigurationSupportingAgentIds).toEqual(['gemini']);
        expect(gemini.runtimeFallbackSupportingAgentIds).toEqual(['gemini']);
        expect(isConnectedServiceAccountGroupConfigurationSupported('gemini')).toBe(true);
        expect(isConnectedServiceRuntimeFallbackSupported('gemini')).toBe(true);
    });

    it('keeps same-group runtime fallback support distinct from broader group configuration support', () => {
        const codex = resolveConnectedServiceRuntimeFallbackCapability('openai-codex');

        expect(codex.groupConfigurationSupported).toBe(true);
        expect(codex.runtimeFallbackSupported).toBe(true);
        expect(codex.quotaResetSupported).toBe(true);
        expect(resolveConnectedServiceRuntimeFallbackCapability('anthropic').quotaResetSupported).toBe(false);
        expect(resolveConnectedServiceRuntimeFallbackCapability('openai').quotaResetSupported).toBe(false);
        expect(codex.runtimeFallbackSupportingAgentIds).toContain('codex');
        expect(codex.groupConfigurationSupportingAgentIds).toContain('codex');
    });

    it('permits quota reset policy only for Claude subscription accounts', () => {
        const subscription = resolveConnectedServiceRuntimeFallbackCapability('claude-subscription');
        expect(subscription.quotaResetSupported).toBe(true);
        expect(subscription.runtimeFallbackSupportingAgentIds).toEqual(['claude']);
        expect(resolveConnectedServiceRuntimeFallbackCapability('anthropic').quotaResetSupported).toBe(false);
    });

    it('fails closed for services with no runtime fallback implementation', () => {
        expect(isConnectedServiceRuntimeFallbackSupported('github')).toBe(false);
    });

    it('names the pool agents that take an automatic switch only when the turn ends', () => {
        expect(resolveConnectedServiceRuntimeFallbackCapability('antigravity').turnEndSwitchAgentIds).toEqual(['agy']);
        expect(resolveConnectedServiceRuntimeFallbackCapability('claude-subscription').turnEndSwitchAgentIds).toEqual([]);
        expect(resolveConnectedServiceRuntimeFallbackCapability('openai-codex').turnEndSwitchAgentIds).not.toContain('codex');
    });
});
