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

    it('separates connected-service group configuration from runtime fallback support', () => {
        const gemini = resolveConnectedServiceRuntimeFallbackCapability('gemini');

        expect(gemini.groupConfigurationSupported).toBe(true);
        expect(gemini.runtimeFallbackSupported).toBe(false);
        expect(gemini.groupConfigurationSupportingAgentIds).toEqual(['gemini']);
        expect(gemini.runtimeFallbackSupportingAgentIds).toEqual([]);
        expect(isConnectedServiceAccountGroupConfigurationSupported('gemini')).toBe(true);
        expect(isConnectedServiceRuntimeFallbackSupported('gemini')).toBe(false);
    });

    it('keeps same-group runtime fallback support distinct from broader group configuration support', () => {
        const codex = resolveConnectedServiceRuntimeFallbackCapability('openai-codex');

        expect(codex.groupConfigurationSupported).toBe(true);
        expect(codex.runtimeFallbackSupported).toBe(true);
        expect(codex.runtimeFallbackSupportingAgentIds).toContain('codex');
        expect(codex.groupConfigurationSupportingAgentIds).toContain('codex');
    });

    it('fails closed for services with no runtime fallback implementation', () => {
        expect(isConnectedServiceRuntimeFallbackSupported('github')).toBe(false);
    });
});
