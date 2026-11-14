import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { listVoiceActionBlockSpecs, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('Happier advertisement cost', () => {
  // Regression measurements, never runtime payload limits. Current wire values
  // protect lossless sharing; historical values protect catalog sectioning.
  it.each([
    { surface: 'agent', count: 35, beforeBytes: 1_992_370 },
    { surface: 'mcp', count: 19, beforeBytes: 140_584 },
  ] as const)('keeps $surface advertisements sectioned at catalog scale', async ({ surface, count, beforeBytes }) => {
    const server = new McpServer({ name: 'advertisement-cost', version: '1' });
    registerHappierMcpBuiltInTools(server, {
      surface, sessionId: 'cost-session', actionsSettings: null, pluginToolCatalog: [],
      deps: {
        changeTitle: async () => { throw new Error('Advertisement must not execute tools'); },
        executeActionByToolName: async () => { throw new Error('Advertisement must not execute tools'); },
      },
    });
    const client = new Client({ name: 'advertisement-cost', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const result = await client.listTools();
      const bytes = Buffer.byteLength(JSON.stringify(result.tools));
      console.log(JSON.stringify({ surface, actions: listActionSpecs().length, count: result.tools.length, bytes }));
      console.log(JSON.stringify({ surface, tools: result.tools.map(tool => ({ name: tool.name,
        fields: Object.fromEntries(Object.entries(tool).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])),
      })) }));
      // Measured after lossless inline-subtree sharing; a regression contract,
      // never a runtime payload limit or truncation rule.
      if (surface === 'agent') expect(bytes).toBeLessThanOrEqual(240_324);
      const ajv = new Ajv({ strict: false, validateFormats: false });
      for (const tool of result.tools) {
        // Every retained reference must compile on the real tools/list wire.
        expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
        if (tool.outputSchema) expect(() => ajv.compile(tool.outputSchema), tool.name).not.toThrow();
      }
      if (surface === 'agent') {
        const native = resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'cost-session',
          memoryRecallGuidanceEnabled: false, sessionMemoryEnabled: true, isServerFeatureEnabled: () => true });
        expect(result.tools.map(tool => tool.name)).toEqual(native.map(tool => tool.name));
      }
      expect(listVoiceActionBlockSpecs().length).toBeGreaterThanOrEqual(471);
      expect(result.tools).toHaveLength(count);
      expect(bytes).toBeLessThan(beforeBytes);
      // Named schema sections belong to on-demand Action discovery, not each fresh advertisement.
      for (const tool of result.tools) {
        expect(JSON.stringify(tool.inputSchema).includes('"definitions":')).toBe(false);
        expect((JSON.stringify(tool.outputSchema) ?? '').includes('"definitions":')).toBe(false);
      }
    } finally { await client.close(); await server.close(); }
  });
  it.each([
    { family: 'native Session tools (including Pi)', count: 35, beforeBytes: 80_542, descriptors: () =>
      resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'cost-session',
        memoryRecallGuidanceEnabled: false, sessionMemoryEnabled: true, isServerFeatureEnabled: () => true }) },
    { family: 'Codex native Voice function', count: 1, beforeBytes: 789_347, descriptors: () => [getVoiceActionFunctionTool()] },
  ])('keeps $family independent of full catalog grammar', ({ family, count, beforeBytes, descriptors }) => {
    const tools = descriptors();
    const bytes = Buffer.byteLength(JSON.stringify(tools));
    console.log(JSON.stringify({ family, count: tools.length, bytes }));
    expect(listVoiceActionBlockSpecs().length).toBeGreaterThanOrEqual(471);
    expect(tools).toHaveLength(count);
    expect(bytes).toBeLessThan(beforeBytes);
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema).includes('"definitions":')).toBe(false);
  });

});
