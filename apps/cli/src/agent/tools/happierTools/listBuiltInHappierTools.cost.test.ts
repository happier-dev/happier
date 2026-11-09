import { describe, expect, it } from 'vitest';
import { Session } from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { ActionsSettingsV1Schema, type ActionId } from '@happier-dev/protocol';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { createHappierToolInventory } from './listBuiltInHappierTools';
import { prepareHappierMcpToolInventory } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { z } from 'zod/mini';

describe('native tool inventory cost', () => {
  it('does not repeat the static approval schema projection on subsequent tools/list conversions', async () => {
    const inspector = new Session();
    const post = <T>(method: string, params?: Record<string, unknown>) => new Promise<T>((resolve, reject) => {
      inspector.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T));
    });
    inspector.connect();
    try {
      await post('Profiler.enable');
      await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
      const inventory = prepareHappierMcpToolInventory({
        sessionId: 'schema-projection-cost',
        inventory: {
          tools: [{
            name: 'schema_projection_cost', title: 'Schema projection cost', description: 'Fixture',
            inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }),
          }],
          actionToolNameToId: new Map(),
        },
      });
      const outputSchema = inventory.registrations[0]?.meta.outputSchema;
      expect(outputSchema).toBeDefined();
      z.toJSONSchema(outputSchema!, { io: 'output' });
      await post('Profiler.takePreciseCoverage');
      z.toJSONSchema(outputSchema!, { io: 'output' });
      const coverage = await post<{
        result: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }>;
      }>('Profiler.takePreciseCoverage');
      const repeatedProjections = coverage.result.flatMap(script => script.functions)
        .filter(fn => fn.functionName === 'zodSchemaToJsonSchemaObject')
        .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);
      expect(repeatedProjections).toBe(0);
    } finally {
      await post('Profiler.stopPreciseCoverage').catch(() => undefined);
      inspector.disconnect();
    }
  });

  it('projects catalog replacement without retaining a previous inventory index', () => {
    const declaration: ProjectedPluginToolCatalogEntry = {
      toolId: 'acme.inventory/read', actionId: 'acme.inventory/actions/read', name: 'acme_read',
      toolExposure: { mcp: 'direct' },
      title: 'Read', description: 'Read', surfaces: ['mcp'], inputSchema: { type: 'object', properties: {} },
    };
    const pluginToolCatalog = [declaration];
    const before = createHappierToolInventory({ surface: 'mcp', pluginToolCatalog, actionsSettings: null });
    const replacement: ProjectedPluginToolCatalogEntry = { ...declaration, name: 'acme_read_next', inputSchema: {
      type: 'object', properties: { label: { type: 'string' } }, required: ['label'],
    } };
    pluginToolCatalog.splice(0, 1, replacement);
    const after = createHappierToolInventory({ surface: 'mcp', pluginToolCatalog, actionsSettings: null });
    expect(after.actionToolNameToId.has('acme_read')).toBe(false);
    expect(after.tools.find(tool => tool.name === replacement.name)?.inputSchema).toBe(replacement.inputSchema);
    expect(after.actionToolNameToId.get(replacement.name)).toBe(declaration.actionId);
    expect(before.actionToolNameToId.has('acme_read_next')).toBe(false);
    pluginToolCatalog.length = 0;
    expect(createHappierToolInventory({ surface: 'mcp', pluginToolCatalog, actionsSettings: null })
      .tools.some(tool => tool.toolId === declaration.toolId)).toBe(false);
  });
  it('derives the dispatch map from the same current exposure decisions as the advertised tools', () => {
    const admitted: ActionId[] = [];
    const inventory = createHappierToolInventory({
      surface: 'cli', pluginToolCatalog: [], actionsSettings: null,
      isActionEnabled: id => { admitted.push(id); return true; },
      isServerFeatureEnabled: () => false,
    });
    const toolActions = new Map(inventory.tools.flatMap(tool => tool.actionId ? [[tool.name, tool.actionId] as const] : []));
    expect(inventory.actionToolNameToId).toEqual(toolActions);
    // One exposure admission per Action-backed tool. Building its dispatch
    // mapping must not re-admit the same advertised declarations.
    expect(admitted.filter(id => id === 'action.spec.get')).toHaveLength(1);
  });

  it.each(['agent', 'mcp', 'cli'] as const)('keeps each plugin tool binding on its own %s surface', surface => {
    const pluginToolCatalog: ProjectedPluginToolCatalogEntry[] = (['agent', 'mcp', 'cli'] as const).map(bindingSurface => ({
      toolId: `acme.inventory/${bindingSurface}`,
      actionId: `acme.inventory/actions/${bindingSurface}`,
      toolExposure: { agent: 'direct', mcp: 'direct', cli: 'direct' },
      name: `acme_read_${bindingSurface}`,
      title: 'Read inventory', description: 'Read through a surface-specific tool binding',
      inputSchema: { type: 'object', properties: {} },
      surfaces: [bindingSurface],
    }));
    const inventory = createHappierToolInventory({ surface, pluginToolCatalog, actionsSettings: null });
    expect(inventory.tools.filter(tool => tool.toolId?.startsWith('acme.inventory/')).map(tool => tool.name))
      .toEqual([`acme_read_${surface}`]);
    expect([...inventory.actionToolNameToId].filter(([name]) => name.startsWith('acme_read_')))
      .toEqual([[`acme_read_${surface}`, `acme.inventory/actions/${surface}`]]);
  });

  it.each([64, 512])('projects %i admitted plugin declarations without whole-catalog reprojection per tool', (size) => {
    let schemaReads = 0;
    let identityReads = 0;
    const inputSchema: ProjectedPluginToolCatalogEntry['inputSchema'] = { type: 'object', properties: { sessionId: { type: 'string' } },
      required: ['sessionId'], additionalProperties: false };
    const pluginToolCatalog: ProjectedPluginToolCatalogEntry[] = Array.from({ length: size }, (_, index) => ({
      toolId: `acme.inventory/action-${index}`,
      toolExposure: { agent: 'direct' },
      get actionId() { identityReads += 1; return `acme.inventory/actions/action-${index}`; },
      name: `acme_inventory_${index}`,
      title: `Inventory ${index}`,
      description: 'An admitted external tool',
      get inputSchema() { schemaReads += 1; return inputSchema; },
      ...(index % 2 === 0 ? { contextualDefaults: { sessionId: 'current_session' as const } } : {}),
      surfaces: ['agent'],
      safety: 'safe',
    }));
    const startedAt = performance.now();
    const inventory = createHappierToolInventory({ surface: 'agent', pluginToolCatalog, actionsSettings: null });
    const elapsedMs = performance.now() - startedAt;
    const projected = inventory.tools.filter(tool => tool.toolId?.startsWith('acme.inventory/'));
    expect(projected).toHaveLength(size);
    for (const tool of projected) {
      expect(tool.inputSchema).toBe(inputSchema);
      expect(inventory.actionToolNameToId.get(tool.name)).toBe(tool.actionId);
    }
    console.info(JSON.stringify({ contract: 'native-tool-inventory', size, schemaReads, identityReads, elapsedMs }));
    // Admit each declaration once. Per-tool lookup and dispatch-map derivation
    // must not scan or re-project the source inventory.
    expect(schemaReads).toBe(size);
    expect(identityReads).toBe(size);

    const prepared = prepareHappierMcpToolInventory({ inventory, sessionId: 'inventory-session' });
    expect(prepared.tools.filter(tool => tool.toolId?.startsWith('acme.inventory/'))).toHaveLength(size);
    const withDefault = prepared.registrations.find(entry => entry.tool.name === 'acme_inventory_0')!;
    const withoutDefault = prepared.registrations.find(entry => entry.tool.name === 'acme_inventory_1')!;
    expect(z.toJSONSchema(withDefault.meta.inputSchema, { io: 'input' }).required ?? []).not.toContain('sessionId');
    expect(z.toJSONSchema(withoutDefault.meta.inputSchema, { io: 'input' }).required).toContain('sessionId');
    // Schema preparation consumes the admitted declarations too; contextual
    // defaults must not rescan that same source once per registered tool.
    expect(schemaReads).toBe(size);
    expect(identityReads).toBe(size);

    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'acme.inventory/actions/action-0': { enabled: false },
    } });
    const changed = createHappierToolInventory({ surface: 'agent', pluginToolCatalog, actionsSettings: settings });
    expect(changed.tools.some(tool => tool.name === 'acme_inventory_0')).toBe(false);
    expect(changed.actionToolNameToId.has('acme_inventory_0')).toBe(false);
    expect(changed.actionToolNameToId.get('acme_inventory_1')).toBe('acme.inventory/actions/action-1');
  });
});
