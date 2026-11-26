import { describe, expect, it } from 'vitest';
import { PluginAgentToolsCapabilityV2Schema } from './v2.js';
describe('MCP tool-control declaration', () => {
  it('preserves both native Code Mode capability values while requiring a boolean', () => {
    for (const nativeCodeMode of [true, false]) {
      expect(PluginAgentToolsCapabilityV2Schema.parse({ delivery: 'native_mcp', nativeCodeMode })).toEqual({
        delivery: 'native_mcp', nativeCodeMode,
      });
    }
    expect(PluginAgentToolsCapabilityV2Schema.safeParse({ delivery: 'native_mcp', nativeCodeMode: 'supported' }).success).toBe(false);
  });
  it('admits an Agent-owned native metadata key while keeping the tools declaration closed', () => {
    expect(PluginAgentToolsCapabilityV2Schema.parse({ delivery: 'native_mcp', mcpToolCallIdMetaKey: 'acme.example/nativeCall' }))
      .toEqual({ delivery: 'native_mcp', mcpToolCallIdMetaKey: 'acme.example/nativeCall' });
    for (const mcpToolCallIdMetaKey of ['', 2, null]) expect(PluginAgentToolsCapabilityV2Schema.safeParse({ delivery: 'native_mcp', mcpToolCallIdMetaKey }).success).toBe(false);
    expect(PluginAgentToolsCapabilityV2Schema.safeParse({ delivery: 'native_mcp', mcpToolCallIdMetaKey: 'call', inferredVendor: true }).success).toBe(false);
  });
  it('admits declared facts and rejects unknown fields and invented authority', () => {
    expect(PluginAgentToolsCapabilityV2Schema.parse({ delivery: 'native_mcp', mcpToolControl: { off: 'blocked', approval: 'host' }, mcpToolLoading: 'on_demand' })).toMatchObject({ mcpToolControl: { off: 'blocked', approval: 'host' } });
    expect(PluginAgentToolsCapabilityV2Schema.parse({ delivery: 'native_mcp' })).toEqual({ delivery: 'native_mcp' });
    for (const mcpToolControl of [{ off: 'hidden', approval: 'guessed' }, { off: 'hidden', approval: 'native', fallback: true }]) expect(PluginAgentToolsCapabilityV2Schema.safeParse({ delivery: 'native_mcp', mcpToolControl }).success).toBe(false);
  });
});
