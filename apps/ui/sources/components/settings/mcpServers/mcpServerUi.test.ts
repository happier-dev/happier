import { describe, expect, it, vi } from 'vitest';

import { getAgentCore } from '@/agents/registry/registryCore';

vi.mock('@/text', () => ({
    t: (key: string) => `tx:${key}`,
}));

import { resolveDetectedProviderName } from './mcpServerUi';

describe('resolveDetectedProviderName', () => {
    it('resolves detected provider labels through the agent registry, including flavor aliases', () => {
        expect(resolveDetectedProviderName('claude')).toBe(`tx:${getAgentCore('claude').displayNameKey}`);
        expect(resolveDetectedProviderName('open-code')).toBe(`tx:${getAgentCore('opencode').displayNameKey}`);
    });

    it('falls back to the raw provider when no registered agent matches', () => {
        expect(resolveDetectedProviderName('unknown-provider')).toBe('unknown-provider');
    });
});
