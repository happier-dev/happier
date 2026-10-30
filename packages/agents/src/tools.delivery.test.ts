import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types';
import { AGENTS_CORE } from './manifest';
import {
  getAgentToolsCapability,
  isAgentToolsUnsupported,
  usesNativeExtensionTools,
  usesNativeMcpTools,
  usesShellBridgeTools,
} from './tools';

describe('agent tools delivery capability', () => {
  it('defines tools delivery metadata for every agent', () => {
    for (const agentId of AGENT_IDS) {
      expect(AGENTS_CORE[agentId].tools).toBeDefined();
      expect(AGENTS_CORE[agentId].tools.delivery).toMatch(/^(native_mcp|native_extension|shell_bridge|unsupported)$/);
      expect(AGENTS_CORE[agentId].tools.support).toMatch(/^(supported|experimental|unsupported)$/);
    }
  });

  it('classifies Pi native extension delivery separately from its agent caller surface', () => {
    expect(getAgentToolsCapability('pi')).toEqual({ delivery: 'native_extension', support: 'experimental',
      mcpToolControl: { off: 'hidden', approval: 'host' } });
    expect(usesNativeExtensionTools('pi')).toBe(true);
    expect(usesNativeMcpTools('pi')).toBe(false);
    expect(usesShellBridgeTools('pi')).toBe(false);
  });

  it('classifies native MCP providers through helper APIs', () => {
    expect(getAgentToolsCapability('claude')).toEqual({ delivery: 'native_mcp', support: 'supported',
      mcpToolControl: { off: 'hidden', approval: 'host' }, mcpToolCallIdMetaKey: 'claudecode/toolUseId' });
    expect(usesNativeMcpTools('claude')).toBe(true);
    expect(usesShellBridgeTools('claude')).toBe(false);
    expect(isAgentToolsUnsupported('claude')).toBe(false);
  });

  it('classifies Gemini native MCP delivery through helper APIs', () => {
    expect(getAgentToolsCapability('gemini')).toEqual({ delivery: 'native_mcp', support: 'supported',
      mcpToolControl: { off: 'blocked', approval: 'host' } });
    expect(usesNativeMcpTools('gemini')).toBe(true);
    expect(usesShellBridgeTools('gemini')).toBe(false);
    expect(isAgentToolsUnsupported('gemini')).toBe(false);
  });

  it.each(['auggie', 'copilot', 'cursor', 'kilo', 'qwen'] as const)(
    'classifies %s native MCP delivery through helper APIs',
    (agentId) => {
      expect(getAgentToolsCapability(agentId)).toEqual({ delivery: 'native_mcp', support: 'experimental',
        ...(agentId === 'kilo' ? { mcpToolControl: { off: 'blocked', approval: 'host' } } : {}) });
      expect(usesNativeMcpTools(agentId)).toBe(true);
      expect(usesShellBridgeTools(agentId)).toBe(false);
      expect(isAgentToolsUnsupported(agentId)).toBe(false);
    },
  );

  it('classifies Antigravity native MCP delivery through helper APIs', () => {
    expect(getAgentToolsCapability('antigravity')).toEqual({ delivery: 'native_mcp', support: 'experimental' });
    expect(usesNativeMcpTools('antigravity')).toBe(true);
    expect(usesShellBridgeTools('antigravity')).toBe(false);
    expect(isAgentToolsUnsupported('antigravity')).toBe(false);
  });
});
