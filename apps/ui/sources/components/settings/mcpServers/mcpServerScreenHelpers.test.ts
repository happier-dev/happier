import { describe, expect, it } from 'vitest';

import { AGENT_IDS, DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';

import { getPreferredMcpPreviewAgentId, listDetectedMcpProviderIds, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';

describe('mcpServerScreenHelpers', () => {
    it('lists detected MCP providers in canonical registry order without screen-local hardcoding', () => {
        expect(listDetectedMcpProviderIds()).toEqual(['claude', 'codex', 'opencode', 'ohMyPi']);
    });

    it('lists preview-capable MCP agents in canonical registry order without screen-local hardcoding', () => {
        expect(listMcpPreviewAgentIds()).toEqual(AGENT_IDS);
    });

    it('prefers the current preview agent when still available and otherwise falls back to the first supported agent', () => {
        expect(getPreferredMcpPreviewAgentId(['codex', 'opencode'], 'opencode')).toBe('opencode');
        expect(getPreferredMcpPreviewAgentId(['codex', 'opencode'], 'claude')).toBe('codex');
        expect(getPreferredMcpPreviewAgentId([], 'claude')).toBe(DEFAULT_AGENT_ID);
    });
});
