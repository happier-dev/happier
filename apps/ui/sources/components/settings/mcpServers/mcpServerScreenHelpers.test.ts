import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';

import { getPreferredMcpPreviewAgentId, listDetectedMcpProviderIds, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';

describe('mcpServerScreenHelpers', () => {
    it('lists detected MCP providers from the protocol contract without screen-local hardcoding', () => {
        expect(listDetectedMcpProviderIds()).toEqual(['claude', 'codex', 'opencode']);
    });

    it('lists preview-capable MCP agents from the agent registry without screen-local hardcoding', () => {
        expect(listMcpPreviewAgentIds()).toEqual(
            expect.arrayContaining(['claude', 'codex', 'opencode', 'gemini', 'auggie', 'kilo', 'kiro', 'customAcp', 'pi', 'kimi', 'qwen', 'copilot']),
        );
    });

    it('prefers the current preview agent when still available and otherwise falls back to the first supported agent', () => {
        expect(getPreferredMcpPreviewAgentId(['codex', 'opencode'], 'opencode')).toBe('opencode');
        expect(getPreferredMcpPreviewAgentId(['codex', 'opencode'], 'claude')).toBe('codex');
        expect(getPreferredMcpPreviewAgentId([], 'claude')).toBe(DEFAULT_AGENT_ID);
    });
});
