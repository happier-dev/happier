import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { listVoiceActionBlockSpecs, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionsSettingsV1Schema, createActionExecutor } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('Happier advertisement cost', () => {
  it('keeps a demoted Action reachable through search, describe and execute, including explicit Account exposure', async () => {
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      // Execution-run transport is the system boundary; admission/dispatch remain real.
      executionRunList: async () => ({ runs: [] }),
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor });
    const server = new McpServer({ name: 'catalog-discovery', version: '1' });
    registerHappierMcpBuiltInTools(server, { surface: 'agent', sessionId: 'cost-session',
      actionsSettings: null, pluginToolCatalog: [], deps: { ...bridge,
        changeTitle: async () => ({ success: true }),
      } });
    const client = new Client({ name: 'catalog-discovery', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('execution_run_list');
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError, JSON.stringify(response)).toBe(false);
        const content = response.content as Array<{ type: string; text?: string }>;
        return JSON.parse(content.find(item => item.type === 'text')!.text!);
      };
      const search = await call('action_spec_search', { query: 'execution.run.list' });
      expect(search.actionSpecs.some((spec: { id: string }) => spec.id === 'execution.run.list')).toBe(true);
      const described = await call('action_spec_get', { id: 'execution.run.list' });
      expect(described.actionSpec.outputSchema).toBeDefined();
      expect(await call('action_execute', { actionId: 'execution.run.list', input: { sessionId: 'cost-session' } })).toEqual({ runs: [] });
      const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'execution.run.list': { toolExposureModes: { agent: 'direct' } },
      } });
      const inventory = createHappierToolInventory({ surface: 'agent', actionsSettings: settings, pluginToolCatalog: [] });
      expect(inventory.tools.map(tool => tool.name)).toContain('execution_run_list');
    } finally { await client.close(); await server.close(); }
  });

  // Regression measurements, never runtime payload limits. Current wire values
  // protect lossless sharing; historical values protect catalog sectioning.
  it.each([
    { surface: 'agent', count: 9, beforeBytes: 1_992_370 },
    { surface: 'mcp', count: 9, beforeBytes: 140_584 },
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
      if (surface === 'agent') expect(bytes).toBeLessThanOrEqual(20_000);
      const ajv = new Ajv({ strict: false, validateFormats: false });
      for (const tool of result.tools) {
        // Every retained reference must compile on the real tools/list wire.
        expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
        expect(tool.outputSchema, tool.name).toBeUndefined();
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
    { family: 'native Session tools (including Pi)', count: 9, beforeBytes: 80_542, descriptors: () =>
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
