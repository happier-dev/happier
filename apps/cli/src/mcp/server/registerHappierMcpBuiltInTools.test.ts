import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, ComputerCaptureResponseV1Schema } from '@happier-dev/protocol';
import { z } from 'zod/mini';
import Ajv from 'ajv';
import * as mini from 'zod/mini';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '@/configuration';

import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';
import { ActionJsonSchemaProjectionError, zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { projectExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { projectMcpToolInputJsonSchema } from './projectMcpToolInputJsonSchema';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';

describe('registerHappierMcpBuiltInTools', () => {
  it('does not reproject registered tool schemas after the first tools/list request', async () => {
    const tool = { name: 'schema_projection_cost', title: 'Schema projection cost', description: 'Fixture',
      inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
    const { mcp: server, toolNames } = createExternalMcpServer({ credentials: { token: 'schema-projection-fixture', encryption: null } });
    const bridge = createActionToolExecutorBridge({ surface: 'mcp',
      executor: createActionExecutor(createUnavailableActionTransportDeps()) });
    registerHappierMcpBuiltInTools(server, {
      sessionId: 'schema-projection-cost', surface: 'mcp',
      toolInventory: prepareHappierMcpToolInventory({ sessionId: 'schema-projection-cost',
        inventory: { tools: [tool], actionToolNameToId: new Map() } }),
      deps: { ...bridge, changeTitle: async () => ({ success: true }),
        resolveActionOptions: args => bridge.resolveActionOptions(args, 'schema-projection-cost') },
    });
    const client = new Client({ name: 'schema-projection-cost', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const inspector = new Session();
    const post = <T>(method: string, params?: Record<string, unknown>) => new Promise<T>((resolve, reject) => {
      inspector.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as T));
    });
    inspector.connect();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await post('Profiler.enable');
      await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
      const baseline = (await client.listTools()).tools.map(tool => tool.name);
      expect(baseline).toEqual([...toolNames, 'schema_projection_cost']);
      const later = server.registerTool('later_tool', { inputSchema: z.object({}) }, async () => ({ content: [] }));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([...baseline, 'later_tool']);
      later.disable();
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(baseline);
      later.enable();
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([...baseline, 'later_tool']);
      later.remove();
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(baseline);
      const toRename = server.registerTool('rename_source', { inputSchema: z.object({}) }, async () => ({ content: [] }));
      toRename.update({ name: 'renamed_tool', paramsSchema: { label: z.string() } });
      const renamed = (await client.listTools()).tools.find(tool => tool.name === 'renamed_tool');
      expect(renamed?.inputSchema).toMatchObject({ required: ['label'] });
      expect((await client.listTools()).tools.some(tool => tool.name === 'rename_source')).toBe(false);
      await post('Profiler.takePreciseCoverage');
      await client.listTools();
      const coverage = await post<{
        result: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }>;
      }>('Profiler.takePreciseCoverage');
      const repeatedProjections = coverage.result.flatMap(script => script.functions)
        .filter(fn => fn.functionName === 'toJsonSchemaCompat' || fn.functionName === 'zodSchemaToJsonSchemaObject')
        .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);
      expect(repeatedProjections).toBe(0);
    } finally {
      await post('Profiler.stopPreciseCoverage').catch(() => undefined);
      inspector.disconnect();
      await client.close();
      await server.close();
    }
  });

  it('shares repeated native tool input schemas through MCP discovery without losing their contracts', async () => {
    const spec = getActionSpec('session.board.item.upsert');
    const example = spec.examples?.mcp?.argsExample;
    if (!example) throw new Error('Expected the canonical Board authoring example');
    const input: unknown = JSON.parse(example);
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    const inventory = prepareHappierMcpToolInventory({ sessionId: '', inventory: {
      tools: [{ name: 'session_board_item_upsert', title: spec.title, description: spec.description ?? spec.title,
        actionId: spec.id, inputSchema: spec.inputSchema }],
      actionToolNameToId: new Map([['session_board_item_upsert', spec.id]]),
    } });
    const server = new McpServer({ name: 'native-schema-test', version: '1.0.0' });
    const bridge = createActionToolExecutorBridge({ surface: 'agent',
      executor: createActionExecutor(createUnavailableActionTransportDeps()) });
    registerHappierMcpBuiltInTools(server, { sessionId: '', surface: 'agent', toolInventory: inventory,
      deps: { ...bridge, changeTitle: async () => ({ success: true }),
        resolveActionOptions: args => bridge.resolveActionOptions(args, '') } });
    const client = new Client({ name: 'native-schema-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools[0]!;
      const compiler = new Ajv({ strict: false, validateFormats: false });
      const validate = compiler.compile(advertised.inputSchema);
      expect(validate(input)).toBe(true);
      expect(validate({ itemId: 'incomplete' })).toBe(false);
      // Mis-binding the schema producer cannot certify the Board invocation.
      expect(compiler.compile(zodSchemaToJsonSchemaObject(getActionSpec('workflow.run.get').inputSchema,
        { target: 'draft-7' }))(input)).toBe(false);
      const inline = projectMcpToolInputJsonSchema(zodSchemaToJsonSchemaObject(spec.inputSchema,
        { target: 'draft-7', reused: 'inline' }));
      expect(JSON.stringify(advertised.inputSchema).length).toBeLessThan(JSON.stringify(inline).length);
      // Discovery must carry the definitions consumed by its advertised references.
      expect(() => new Ajv({ strict: false, validateFormats: false }).compile({ ...advertised.inputSchema, definitions: {} })).toThrow();
    } finally { await client.close(); await server.close(); }
  });

  it('contains malformed structured output at the MCP boundary and keeps healthy calls available', async () => {
    const tool = { name: 'change_title', title: 'Change title', description: 'Change title',
      inputSchema: z.strictObject({ title: z.string() }), outputSchema: z.strictObject({ success: z.boolean() }) };
    const server = new McpServer({ name: 'structured-output-test', version: '1.0.0' });
    const bridge = createActionToolExecutorBridge({ surface: 'mcp',
      executor: createActionExecutor(createUnavailableActionTransportDeps()) });
    let response: unknown = 'invalid structured result';
    registerHappierMcpBuiltInTools(server, {
      sessionId: 'sess-1', surface: 'mcp',
      toolInventory: prepareHappierMcpToolInventory({ sessionId: 'sess-1',
        inventory: { tools: [tool], actionToolNameToId: new Map() } }),
      // Rename is a server write boundary; dispatch and the MCP transport remain real.
      deps: { ...bridge, changeTitle: async () => response,
        resolveActionOptions: args => bridge.resolveActionOptions(args, 'sess-1') },
    });
    const client = new Client({ name: 'structured-output-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const malformed = await client.callTool({ name: 'change_title', arguments: { title: 'Bad result' } });
      expect(malformed).toMatchObject({ isError: true,
        content: [{ type: 'text', text: expect.stringContaining('"errorCode":"tool_failed"') }] });
      response = { success: true };
      expect(await client.callTool({ name: 'change_title', arguments: { title: 'Healthy result' } })).toMatchObject({
        isError: false, structuredContent: { success: true },
      });
    } finally { await client.close(); await server.close(); }
  });

  it('advertises the real usage output through MCP discovery with resolvable document-local references', async () => {
    const spec = getActionSpec('usage.query');
    const inventory = prepareHappierMcpToolInventory({ sessionId: 'cli-global', inventory: {
      tools: [{ name: 'usage_query', title: spec.title, description: spec.description ?? spec.title,
        actionId: spec.id, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema }],
      actionToolNameToId: new Map([['usage_query', spec.id]]),
    } });
    const server = new McpServer({ name: 'parity-schema-test', version: '1.0.0' });
    const meta = inventory.registrations[0]!.meta as { inputSchema: z.ZodMiniType; outputSchema: z.ZodMiniType };
    server.registerTool('usage_query', meta, async () => ({ content: [] }));
    const client = new Client({ name: 'parity-schema-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      // The real SDK client compiles advertised output schemas during discovery.
      const result = await client.listTools();
      expect(result.tools).toEqual([expect.objectContaining({ name: 'usage_query', outputSchema: expect.any(Object) })]);
    } finally { await client.close(); await server.close(); }
  });

  it('presents Mini Action inputs and validates completed outputs without treating parsers as JSON', () => {
    const schema = mini.strictObject({ label: mini.string().check(mini.minLength(1)) });
    const inventory = {
      tools: [{ name: 'mini_action', title: 'Mini Action', description: 'Read a label', inputSchema: schema, outputSchema: schema }],
      actionToolNameToId: new Map<string, string>(),
    };
    const prepared = prepareHappierMcpToolInventory({ inventory, sessionId: 'sess-1' });
    const meta = prepared.registrations[0]!.meta as { inputSchema: z.ZodMiniType; outputSchema: z.ZodMiniType };
    expect(z.toJSONSchema(meta.inputSchema, { target: 'draft-7', io: 'input' })).toMatchObject({
      type: 'object', properties: { label: { type: 'string', minLength: 1 } }, required: ['label'],
    });
    // Input admission belongs to Action dispatch; output validation stays here.
    expect(meta.inputSchema.safeParse({ label: 'Garden' }).success).toBe(true);
    expect(meta.outputSchema.safeParse({ label: 'Garden' }).success).toBe(true);
    expect(meta.outputSchema.safeParse({ label: '' }).success).toBe(false);
    expect(meta.outputSchema.safeParse({ label: 'Garden', undeclared: true }).success).toBe(false);
  });

  it('keeps tools available when optional output metadata is unrepresentable while refusing unrepresentable inputs', () => {
    const inputSchema = z.strictObject({ value: z.string() });
    const outputSchema = z.strictObject({ data: z.custom<unknown>() });
    const tool = { name: 'opaque_result', title: 'Opaque result', description: 'Read an opaque result', inputSchema, outputSchema };
    const inventory = { tools: [tool, { ...tool, name: 'representable_result', outputSchema: inputSchema }], actionToolNameToId: new Map<string, string>() };
    const prepared = prepareHappierMcpToolInventory({ inventory, sessionId: 'sess-1' });
    expect(prepared.registrations.map(entry => entry.tool.name)).toEqual(['opaque_result', 'representable_result']);
    expect(prepared.registrations[0].meta).not.toHaveProperty('outputSchema');
    expect(prepared.registrations[1].meta).toHaveProperty('outputSchema');
    expect(() => prepareHappierMcpToolInventory({
      inventory: { ...inventory, tools: [{ ...tool, inputSchema: outputSchema }] }, sessionId: 'sess-1',
    })).toThrow(ActionJsonSchemaProjectionError);
  });

  it('projects admitted native capture pixels for the host Session and refuses missing or substituted media', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-native-mcp-'));
    const daemonRoot = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    // The filesystem-root configuration is an environment boundary; verification stays real.
    Object.defineProperty(configuration, 'happyHomeDir', { ...daemonRoot, value: cwd });
    try {
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
      const mediaPath = '.happier/uploads/artifacts/sess-1/capture-1/screen.png';
      await mkdir(dirname(join(cwd, mediaPath)), { recursive: true });
      await writeFile(join(cwd, mediaPath), bytes);
      const media = {
        mediaId: 'capture-1', mediaKind: 'image', width: 1, height: 1, sizeBytes: bytes.length,
        file: { sessionId: 'sess-1', storage: 'daemon', path: mediaPath,
          sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png' },
      };
      const capture = ComputerCaptureResponseV1Schema.parse({
        status: 'captured', target: { kind: 'display', displayId: 'display-1' }, sourceId: 'native-screen', captureId: 'capture-1',
        geometry: { captureWidth: 1, captureHeight: 1, nativeWidth: 1, nativeHeight: 1,
          originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 1, height: 1 } },
        media,
      });
      let response: unknown = capture;
      let admitted = true;
      const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
      registerHappierMcpBuiltInTools({ registerTool: (name, _meta, handler) => { handlers.set(name, handler); } }, {
        sessionId: 'sess-1', surface: 'agent', workingDirectory: join(cwd, 'not-the-media-owner'),
        deps: { changeTitle: async () => ({ success: true }), executeActionByToolName: async () => admitted
          ? { ok: true, result: response } : { ok: false, errorCode: 'approval_denied', error: 'denied' } },
      });
      const handler = handlers.get('action_execute');
      if (!handler) throw new Error('Expected action_execute');
      const execute = (actionId = 'computer.capture') => handler({ actionId, input: {} });
      expect(await execute()).toMatchObject({ isError: false,
        content: expect.arrayContaining([{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }]) });
      admitted = false;
      expect(await execute()).toMatchObject({ isError: true,
        content: [{ type: 'text', text: expect.stringContaining('approval_denied') }] });
      admitted = true;
      response = { ...capture, media: { ...media, file: { ...media.file, sessionId: 'sess-2' } } };
      expect(await execute()).toMatchObject({ isError: true,
        content: [{ type: 'text', text: expect.stringContaining('session_media_unavailable') }] });
      response = { ...capture, media: { ...media, file: { ...media.file, sha256: '0'.repeat(64) } } };
      expect(await execute()).toMatchObject({ isError: true });
      response = { ...capture, media: { ...media, file: undefined } };
      expect(await execute()).toMatchObject({ isError: true });
      response = { status: 'captured' };
      expect(await execute()).toMatchObject({ isError: true });
      response = capture;
      const otherPath = '.happier/uploads/artifacts/sess-2/capture-1/screen.png';
      await mkdir(dirname(join(cwd, otherPath)), { recursive: true });
      await writeFile(join(cwd, otherPath), bytes);
      const otherHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
      registerHappierMcpBuiltInTools({ registerTool: (name, _meta, handler) => { otherHandlers.set(name, handler); } }, {
        sessionId: 'sess-1', surface: 'agent', workingDirectory: cwd, resolveSessionId: () => 'sess-2',
        deps: { changeTitle: async () => ({ success: true }), executeActionByToolName: async () => ({ ok: true,
          result: { ...capture, media: { ...media, file: { ...media.file, sessionId: 'sess-2', path: otherPath } } } }) },
      });
      expect(await otherHandlers.get('action_execute')?.({ actionId: 'computer.capture', input: {} })).toMatchObject({ isError: true });
      // Only the approved capture Action may project local image references.
      expect(await execute('computer.query')).toMatchObject({ isError: false,
        content: [{ type: 'text', text: expect.any(String) }] });
      await rm(join(cwd, mediaPath));
      expect(await execute()).toMatchObject({ isError: true });
    } finally {
      Object.defineProperty(configuration, 'happyHomeDir', daemonRoot);
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('projects authorized browser screenshot bytes as MCP image content and refuses missing media', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-browser-mcp-'));
    try {
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
      const mediaPath = '.happier/uploads/artifacts/sess-1/capture/screen.png';
      await mkdir(dirname(join(cwd, mediaPath)), { recursive: true });
      await writeFile(join(cwd, mediaPath), bytes);
      const media = {
        mediaId: 'screenshot', mediaKind: 'image', width: 1, height: 1, sizeBytes: bytes.length,
        file: { sessionId: 'sess-1', storage: 'session', path: mediaPath,
          sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png' },
      };
      const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
      registerHappierMcpBuiltInTools({ registerTool: (name, _meta, handler) => { handlers.set(name, handler); } }, {
        sessionId: 'sess-1', surface: 'agent', workingDirectory: cwd,
        deps: { changeTitle: async () => ({ success: true }), executeActionByToolName: async () => ({ ok: true, result: { media } }) },
      });
      const handler = handlers.get('action_execute');
      if (!handler) throw new Error('Expected action_execute');
      expect(await handler({ actionId: 'browser.context.captureScreenshot', input: {} })).toMatchObject({
        isError: false, content: expect.arrayContaining([{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }]),
      });
      await rm(join(cwd, mediaPath));
      expect(await handler({ actionId: 'browser.context.captureScreenshot', input: {} })).toMatchObject({ isError: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers only MCP-presentable schemas for the real Action and plugin tool inventories', async () => {
    const pluginId = 'acme.mcp-inventory';
    const inputSchema = {
      type: 'object', properties: { label: { $ref: '#/definitions/label' } },
      definitions: { label: { type: 'string', minLength: 1 } },
      required: ['label'], additionalProperties: false,
    };
    // The plugin is physically installed and admitted by the canonical fixture;
    // no registry, activation, policy or projection logic is mocked.
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
        actions: [{ id: 'read', title: 'Read label', scopes: ['global'], surfaces: ['mcp'],
          execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema }],
        tools: [{ id: 'read-tool', name: 'qa_inventory_read', title: 'Read label',
          action: 'read', surfaces: ['mcp'], inputSchema, outputSchema: inputSchema }],
      } }),
      files: { 'daemon.mjs': 'export function activate(api) { api.actions.register("read", async input => input); }' },
    }] });
    try {
      const runtime = fixture.registry;
      await runtime.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'read' }]);
      const pluginToolCatalog = projectExecutablePluginToolCatalog(runtime);
      expect(pluginToolCatalog.length).toBeGreaterThan(0);
      const inventory = createHappierToolInventory({
        surface: 'mcp', registry: runtime.contributes, pluginToolCatalog,
        isActionEnabled: () => true, actionsSettings: null,
      });
      expect(inventory.tools).toContainEqual(expect.objectContaining({
        name: 'qa_inventory_read', actionId: `${pluginId}/actions/read`,
      }));
      // Exercise each eager input with its real Action mapping and plugin context.
      // The assertion names the inventory entry that would abort MCP initialize.
      for (const tool of inventory.tools) {
        expect(() => prepareHappierMcpToolInventory({
          inventory: { ...inventory, tools: [tool] }, sessionId: '',
        }), `${tool.name} (${tool.actionId ?? 'manual'})`).not.toThrow();
      }
      const toolInventory = prepareHappierMcpToolInventory({ inventory, sessionId: '' });
      const registrations: Array<Readonly<{
        name: string;
        meta: { inputSchema?: z.ZodMiniType; outputSchema?: z.ZodMiniType };
      }>> = [];

      registerHappierMcpBuiltInTools({
        registerTool: (name, meta) => registrations.push({
          name,
          meta: meta as { inputSchema?: z.ZodMiniType; outputSchema?: z.ZodMiniType },
        }),
      }, {
        sessionId: '',
        surface: 'mcp',
        pluginToolCatalog,
        toolInventory,
        deps: {
          changeTitle: async () => ({ success: true }),
          executeActionByToolName: async () => ({ ok: true as const, result: {} }),
        },
      });

      expect(registrations.length).toBeGreaterThan(0);
      const incompatibleInputs = registrations.flatMap((registration, index) => {
        const input = registration.meta.inputSchema
          ? z.toJSONSchema(registration.meta.inputSchema, { target: 'draft-7', io: 'input' })
          : null;
        return !input || input.type !== 'object' || ['oneOf', 'anyOf', 'allOf'].some(key => key in input)
          ? [{ index, name: registration.name, combinators: Object.keys(input ?? {}).filter(key => ['oneOf', 'anyOf', 'allOf'].includes(key)) }]
          : [];
      });
      expect(incompatibleInputs).toEqual([]);
      const plugin = registrations.find(registration => registration.name === 'qa_inventory_read');
      if (!plugin?.meta.inputSchema) throw new Error('Expected the admitted external tool');
      const advertisedPluginSchema = zodSchemaToJsonSchemaObject(plugin.meta.inputSchema, { target: 'draft-7' });
      const validatePlugin = compilePluginJsonSchema(advertisedPluginSchema);
      expect(validatePlugin({ label: 'kept' })).toBe(true);
      expect(validatePlugin({ label: '' })).toBe(false);
      expect(() => compilePluginJsonSchema({ ...advertisedPluginSchema, definitions: {} })).toThrow();
      for (const registration of registrations) {
        expect(() => registration.meta.inputSchema
          ? z.toJSONSchema(registration.meta.inputSchema, { target: 'draft-7', io: 'input' })
          : null, registration.name).not.toThrow();
        expect(() => registration.meta.outputSchema
          ? z.toJSONSchema(registration.meta.outputSchema, { target: 'draft-7', io: 'output' })
          : null, registration.name).not.toThrow();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps Action normalization at canonical dispatch instead of applying it in MCP presentation', async () => {
    const registered = new Map<string, {
      meta: { inputSchema?: z.ZodMiniType };
      handler: (args: unknown) => Promise<unknown>;
    }>();
    const executeActionByToolName = vi.fn(async () => ({ ok: true as const, result: { status: 'updated' } }));

    registerHappierMcpBuiltInTools({
      registerTool: (name, meta, handler) => registered.set(name, {
        meta: meta as { inputSchema?: z.ZodMiniType },
        handler,
      }),
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'session.title.set': { toolExposureModes: { mcp: 'direct' } },
      } }),
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    const tool = registered.get('session_title_set');
    if (!tool?.meta.inputSchema) throw new Error('Expected session_title_set to be registered');
    const rawInput = { title: '  canonical title  ' };
    const presented = tool.meta.inputSchema.safeParse(rawInput);
    expect(presented.success).toBe(true);
    if (!presented.success) throw new Error('Expected MCP presentation input to be valid');
    expect(presented.data).toEqual(rawInput);

    await tool.handler(rawInput);
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_title_set',
      rawInput,
      'sess-1',
      { actionRequestId: expect.any(String) },
    );
  });

  it('projects read annotations onto concrete execution observation tools but not opaque action_execute', () => {
    const registrations = new Map<string, Record<string, unknown>>();

    registerHappierMcpBuiltInTools({
      registerTool: (name, meta) => registrations.set(name, meta as Record<string, unknown>),
    }, {
      sessionId: 'sess-1',
      surface: 'agent',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({ ok: true as const, result: {} }),
      },
    });

    for (const toolName of ['execution_run_list', 'execution_run_get', 'execution_run_wait']) {
      expect(registrations.get(toolName)?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
    expect(registrations.get('action_execute')).not.toHaveProperty('annotations');
  });

  it('registers and executes only the Session reads promoted by the Run profile', async () => {
    const registered = new Map<string, (args: unknown) => Promise<unknown>>();
    const executeActionByToolName = vi.fn(async () => ({ ok: true as const, result: { messages: [] } }));

    registerHappierMcpBuiltInTools({
      registerTool: (name, _meta, handler) => {
        registered.set(name, handler as (args: unknown) => Promise<unknown>);
      },
    }, {
      sessionId: 'sess-1',
      surface: 'agent',
      requiredDirectActionIds: ['session.transcript.get'],
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    expect(registered.has('session_transcript_get')).toBe(true);
    expect(registered.has('discussion_post')).toBe(false);
    await expect(registered.get('session_transcript_get')?.({ limit: 10 })).resolves.toMatchObject({
      isError: false,
    });
    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_transcript_get',
      { limit: 10 },
      'sess-1',
      expect.objectContaining({
        approvalOrigin: expect.objectContaining({
          kind: 'transcript_tool_call',
          sessionId: 'sess-1',
          toolName: 'session_transcript_get',
        }),
      }),
    );
  });

  it('adapts the complete plugin tool presentation to the MCP SDK contract', async () => {
    const registered = new Map<string, {
      meta: unknown;
      handler: (args: unknown) => Promise<unknown>;
    }>();

    registerHappierMcpBuiltInTools({
      registerTool: (name, meta, handler) => {
        registered.set(name, { meta, handler });
      },
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      pluginToolCatalog: [{
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/actions/review-start',
        name: 'acme_review_start',
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
          },
          required: ['scope'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          definitions: { completion: { type: 'boolean' } },
          properties: {
            completed: { $ref: '#/definitions/completion' },
            literal: { const: { $ref: '#/definitions/literal-data' } },
          },
          required: ['completed'],
          additionalProperties: false,
        },
        safety: 'danger',
        inputHints: {
          fields: [{
            path: 'scope',
            title: 'Scope',
            widget: 'select',
          }],
        },
        examples: { mcp: { argsExample: '{"scope":"diff"}' } },
        promptSnippet: 'Start an Acme review.',
        promptGuidelines: ['Choose the narrowest applicable scope.'],
        availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
        surfaces: ['agent', 'mcp', 'cli'],
      }],
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({ ok: true as const, result: { completed: true } }),
      },
    });

    const registration = registered.get('acme_review_start');
    const meta = registration?.meta as {
      inputSchema?: z.ZodMiniType;
      outputSchema?: z.ZodMiniType;
      annotations?: unknown;
      _meta?: unknown;
    } | undefined;
    expect(meta?.inputSchema?.safeParse({ scope: 'diff' }).success).toBe(true);
    expect(meta?.inputSchema ? z.toJSONSchema(meta.inputSchema, { target: 'draft-7' }) : null).toMatchObject({
      type: 'object',
      properties: {
        scope: { type: 'string' },
      },
      required: ['scope'],
      additionalProperties: false,
    });
    const advertisedOutput = meta?.outputSchema ? z.toJSONSchema(meta.outputSchema, { target: 'draft-7' }) : null;
    expect(advertisedOutput).toMatchObject({
      type: 'object',
      anyOf: [
        { properties: { completed: { $ref: '#/anyOf/0/definitions/completion' },
          literal: { const: { $ref: '#/definitions/literal-data' } } }, required: ['completed'], additionalProperties: false },
        { properties: { kind: { const: 'approval_request_created' } }, required: ['kind', 'artifactId', 'actionId'], additionalProperties: false },
      ],
    });
    if (!advertisedOutput) throw new Error('Expected advertised output schema');
    const validateAdvertisedOutput = compilePluginJsonSchema(JSON.parse(JSON.stringify(advertisedOutput)));
    expect(validateAdvertisedOutput({ completed: true, literal: { $ref: '#/definitions/literal-data' } })).toBe(true);
    expect(validateAdvertisedOutput({ completed: 'true' })).toBe(false);
    expect(validateAdvertisedOutput({ kind: 'approval_request_created', artifactId: 'approval',
      actionId: 'acme.review.plugin/actions/review-start' })).toBe(true);
    expect(validateAdvertisedOutput({ kind: 'approval_request_created', artifactId: '',
      actionId: 'acme.review.plugin/actions/review-start' })).toBe(false);
    expect(meta?.outputSchema?.safeParse({ completed: true }).success).toBe(true);
    expect(meta?.outputSchema?.safeParse({ completed: 'true' }).success).toBe(false);
    expect(meta?.outputSchema?.safeParse({ kind: 'approval_request_created', artifactId: 'approval',
      actionId: 'acme.review.plugin/actions/review-start' }).success).toBe(true);
    expect(meta?.outputSchema?.safeParse({ kind: 'approval_request_created', artifactId: '',
      actionId: 'acme.review.plugin/actions/review-start' }).success).toBe(false);
    expect(meta?.outputSchema?.safeParse({ kind: 'approval_request_created', artifactId: 'approval',
      actionId: 'acme.review.plugin/actions/review-start', completed: true }).success).toBe(false);
    expect(meta?.annotations).toEqual({ destructiveHint: true });
    expect(meta?._meta).toEqual({
      'happier.dev/pluginTool': {
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/actions/review-start',
        safety: 'danger',
        inputHints: {
          fields: [{
            path: 'scope',
            title: 'Scope',
            widget: 'select',
          }],
        },
        examples: { mcp: { argsExample: '{"scope":"diff"}' } },
        promptSnippet: 'Start an Acme review.',
        promptGuidelines: ['Choose the narrowest applicable scope.'],
        availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
      },
    });
    await expect(registration?.handler({ scope: 'diff' })).resolves.toEqual({
      content: [{ type: 'text', text: '{"completed":true}' }],
      structuredContent: { completed: true },
      isError: false,
    });
  });

  it('allows direct session action tools to rely on the MCP default session target', () => {
    const registered = new Map<string, unknown>();

    registerHappierMcpBuiltInTools({
      registerTool: (name, meta) => {
        registered.set(name, meta);
      },
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'session.terminalComposer.clear': { toolExposureModes: { mcp: 'direct' } },
      } }),
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({ ok: true as const, result: { status: 'cleared' } }),
      },
    });

    const meta = registered.get('session_terminal_composer_clear') as { inputSchema?: z.ZodMiniType } | undefined;
    if (!meta?.inputSchema) throw new Error('Expected session_terminal_composer_clear to be registered');
    // Control: the canonical Action contract requires sessionId; only the bound MCP context makes it optional.
    expect(zodSchemaToJsonSchemaObject(getActionSpec('session.terminalComposer.clear').inputSchema, { target: 'draft-7' }).required)
      .toContain('sessionId');
    const advertised = z.toJSONSchema(meta.inputSchema, { target: 'draft-7', io: 'input' }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(advertised.properties).toHaveProperty('sessionId');
    expect(advertised.required ?? []).not.toContain('sessionId');
  });

  it('does not let process action settings disable built-in MCP tools when no predicate is provided', () => {
    const previous = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    const registered: string[] = [];

    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'execution.run.list': { enabled: true, disabledSurfaces: ['mcp'], disabledPlacements: [] },
      },
    });

    try {
      registerHappierMcpBuiltInTools({
        registerTool: (name) => {
          registered.push(name);
        },
      }, {
        sessionId: 'sess-1',
        surface: 'mcp',
        deps: {
          changeTitle: async () => ({ success: true }),
          executeActionByToolName: async () => ({ ok: true as const, result: { sessions: [] } }),
        },
      });

      expect(registered).toContain('execution_run_list');
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      } else {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previous;
      }
    }
  });

  it.each([
    { label: 'Codex 0.162.1', key: 'callId', meta: { callId: 'exec-transcript-call', itemId: 'fc-response-item' }, toolCallId: 'exec-transcript-call' },
    { label: 'Claude Code 2.1.304', key: 'claudecode/toolUseId', meta: { 'claudecode/toolUseId': 'toolu-transcript-call' }, toolCallId: 'toolu-transcript-call' },
    { label: 'uncorrelated client', key: undefined, meta: { progressToken: 1 }, toolCallId: undefined },
    { label: 'malformed correlation', key: 'callId', meta: { callId: 2, 'claudecode/toolUseId': '' }, toolCallId: undefined },
  ])('derives honest approval origin metadata for $label', async ({ key, meta, toolCallId }) => {
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
    const executeActionByToolName = vi.fn(async () => ({ ok: true as const, result: { sessions: [] } }));
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            agent: 'direct',
          },
        },
      },
    });

    registerHappierMcpBuiltInTools({
      registerTool: (name, _meta, handler) => {
        handlers.set(name, handler as (args: unknown, extra?: unknown) => Promise<unknown>);
      },
    }, {
      sessionId: 'sess-1',
      mcpToolCallIdMetaKey: key,
      surface: 'agent',
      actionsSettings,
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    const handler = handlers.get('session_list');
    if (!handler) throw new Error('Expected session_list to be registered');

    await handler({ limit: 20, ignoredSecret: 'must-not-be-persisted-in-origin' }, { requestId: 'jsonrpc-request-1', _meta: meta });

    expect(executeActionByToolName).toHaveBeenCalledWith(
      'session_list',
      { limit: 20, ignoredSecret: 'must-not-be-persisted-in-origin' },
      'sess-1',
      {
        actionRequestId: expect.any(String),
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'sess-1',
          ...(toolCallId ? { toolCallId } : {}),
          mcpRequestId: 'jsonrpc-request-1',
          toolName: 'session_list',
        },
      },
    );
  });

  it('does not register permission approval as an MCP tool', async () => {
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();

    registerHappierMcpBuiltInTools({
      registerTool: (name, _meta, handler) => {
        handlers.set(name, handler as (args: unknown, extra?: unknown) => Promise<unknown>);
      },
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName: async () => ({ ok: true as const, result: undefined }),
      },
    });

    expect(handlers.get('session_permission_respond')).toBeUndefined();
  });

  it('keeps an active tool call alive with requested MCP progress notifications', async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
    let completeAction!: (value: { ok: true; result: Record<string, never> }) => void;
    const executeActionByToolName = vi.fn(() => new Promise<{ ok: true; result: Record<string, never> }>((resolve) => {
      completeAction = resolve;
    }));

    registerHappierMcpBuiltInTools({
      registerTool: (name, _meta, handler) => {
        handlers.set(name, handler as (args: unknown, extra?: unknown) => Promise<unknown>);
      },
    }, {
      sessionId: 'sess-1',
      surface: 'mcp',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'session.list': { toolExposureModes: { mcp: 'direct' } },
      } }),
      deps: {
        changeTitle: async () => ({ success: true }),
        executeActionByToolName,
      },
    });

    const handler = handlers.get('session_list');
    if (!handler) throw new Error('Expected session_list to be registered');
    const sendNotification = vi.fn(async () => undefined);
    const call = handler({}, {
      _meta: { progressToken: 'progress-1' },
      sendNotification,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const notificationsAfterKeepaliveInterval = [...sendNotification.mock.calls];
    completeAction({ ok: true, result: {} });
    await call;

    expect(notificationsAfterKeepaliveInterval).toContainEqual([{
      method: 'notifications/progress',
      params: {
        progressToken: 'progress-1',
        progress: 1,
      },
    }]);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
