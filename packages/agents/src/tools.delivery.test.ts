import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types';
import { AGENTS_CORE } from './manifest';
import {
  getAgentToolsCapability,
  isAgentToolsUnsupported,
  usesNativeMcpTools,
  usesShellBridgeTools,
} from './tools';

describe('agent tools delivery capability', () => {
  it('defines tools delivery metadata for every agent', () => {
    for (const agentId of AGENT_IDS) {
      expect(AGENTS_CORE[agentId].tools).toBeDefined();
      expect(AGENTS_CORE[agentId].tools.delivery).toMatch(/^(native_mcp|shell_bridge|unsupported)$/);
      expect(AGENTS_CORE[agentId].tools.support).toMatch(/^(supported|experimental|unsupported)$/);
    }
  });

  it('classifies native MCP providers through helper APIs', () => {
    expect(getAgentToolsCapability('claude')).toEqual({ delivery: 'native_mcp', support: 'supported' });
    expect(usesNativeMcpTools('claude')).toBe(true);
    expect(usesShellBridgeTools('claude')).toBe(false);
    expect(isAgentToolsUnsupported('claude')).toBe(false);
  });

  it('classifies Gemini as a native MCP provider through helper APIs', () => {
    expect(getAgentToolsCapability('gemini')).toEqual({ delivery: 'native_mcp', support: 'supported' });
    expect(usesNativeMcpTools('gemini')).toBe(true);
    expect(usesShellBridgeTools('gemini')).toBe(false);
    expect(isAgentToolsUnsupported('gemini')).toBe(false);
  });

  it('routes Cursor Happier tools through the shell bridge', () => {
    expect(getAgentToolsCapability('cursor')).toEqual({ delivery: 'shell_bridge', support: 'experimental' });
    expect(usesNativeMcpTools('cursor')).toBe(false);
    expect(usesShellBridgeTools('cursor')).toBe(true);
    expect(isAgentToolsUnsupported('cursor')).toBe(false);
  });

  it('keeps observed Grok MCP negotiation experimental until authenticated tool QA passes', () => {
    expect(getAgentToolsCapability('grok')).toEqual({ delivery: 'native_mcp', support: 'experimental' });
    expect(usesNativeMcpTools('grok')).toBe(true);
    expect(isAgentToolsUnsupported('grok')).toBe(false);
  });
});
