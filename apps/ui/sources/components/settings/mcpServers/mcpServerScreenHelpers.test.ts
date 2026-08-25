import { describe, expect, it } from 'vitest';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore } from '@/agents/catalog/catalog';

import { getPreferredMcpPreviewAgentId, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';

describe('mcpServerScreenHelpers', () => {
    it('lists preview-capable MCP agents in canonical registry order without screen-local hardcoding', () => {
        const previewAgentIds = listMcpPreviewAgentIds();

        // Derived from the registry, so it is an order-preserving subsequence of it.
        expect(AGENT_IDS.filter((agentId) => previewAgentIds.includes(agentId))).toEqual(previewAgentIds);
        // An Agent that can be handed tools is offered...
        expect(previewAgentIds).toEqual(expect.arrayContaining(['claude', 'codex']));
        // ...and one that declares no tool delivery is not, so the list is a real
        // capability projection rather than the registry echoed back.
        const undeliverableAgentIds = AGENT_IDS.filter((agentId) => getAgentCore(agentId).tools.delivery === 'unsupported');
        expect(undeliverableAgentIds.length).toBeGreaterThan(0);
        for (const agentId of undeliverableAgentIds) {
            expect(previewAgentIds).not.toContain(agentId);
        }
    });

    it('prefers the current preview agent when still available and otherwise falls back to the first supported agent', () => {
        expect(getPreferredMcpPreviewAgentId(['codex', 'opencode'], 'opencode')).toBe('opencode');
        expect(getPreferredMcpPreviewAgentId(['codex', 'opencode'], 'claude')).toBe('codex');
        expect(getPreferredMcpPreviewAgentId([], 'claude')).toBe(DEFAULT_AGENT_ID);
    });
});
