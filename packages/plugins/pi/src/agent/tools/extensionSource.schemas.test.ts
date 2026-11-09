import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Model, Tool } from 'pi-ai-0821';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { resolveSessionNativeToolDescriptors } from '@/agent/tools/happierTools/resolveSessionNativeToolBridge';
import { projectMcpToolInputJsonSchema } from '@/mcp/server/projectMcpToolInputJsonSchema';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { projectExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import { preparePiHappierToolsExtension } from './assets.js';

const anthropicModel = {
  api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://example.invalid',
  id: 'claude-sonnet-4-5', name: 'Schema contract', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024,
} satisfies Model<'anthropic-messages'>;
const messages = [{ role: 'user' as const, content: 'Schema contract', timestamp: 0 }];
const aliases = ['pi-ai-0810', 'pi-ai-0811', 'pi-ai-0820', 'pi-ai-0821'] as const;

// Exact installed serializers, with only the network boundary guarded. onPayload
// runs after tool conversion and throws before any vendor transport is invoked.
async function anthropicParameters(alias: typeof aliases[number], tools: Tool[], extension?: Awaited<ReturnType<typeof loadExtension>>,
  options: { bound?: boolean; oauth?: boolean; strict?: boolean } = {}) {
  const { stream } = await import(`${alias}/api/anthropic-messages`);
  let captured: unknown;
  await stream({ ...anthropicModel, compat: { supportsStrictTools: options.strict === true } }, { messages, tools }, {
    apiKey: options.oauth ? 'sk-ant-oat-synthetic-schema-contract' : 'schema-contract-placeholder', cacheRetention: 'none',
    async onPayload(payload: unknown) {
      captured = extension ? await extension.payload(alias, payload, options.bound) : payload;
      throw new Error('Payload captured before network');
    },
  }).result();
  expect(captured).toBeDefined();
  // Vendor payload is an untyped system boundary; only its tool-schema arm is read.
  return (captured as { tools: { name: string; input_schema: object; strict?: boolean }[] }).tools;
}

async function loadExtension(params: Parameters<typeof preparePiHappierToolsExtension>[0], observeTool?: (tool: Tool) => void) {
  const prepared = await preparePiHappierToolsExtension(params);
  const handlers = new Map<string, Array<(event: unknown) => unknown>>();
  const tools: Tool[] = [];
  let activeTools: string[] | undefined;
  const getActiveTools = () => activeTools ?? tools.map(tool => tool.name);
  try {
    const extension = await import(pathToFileURL(prepared.extensionPath).href);
    extension.default({ registerFlag() {}, getFlag: () => prepared.configPath,
      registerTool(tool: Tool) { tools.push(tool); observeTool?.(tool); },
      on(name: string, handler: (event: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      getAllTools: () => tools,
      getActiveTools, setActiveTools(names: string[]) { activeTools = names; },
    });
    for (const handler of handlers.get('session_start') ?? []) await handler({});
    return { tools, getActiveTools, setActiveTools(names: string[]) { activeTools = names; },
      async payload(alias: typeof aliases[number], payload: unknown, bound = true) {
        // Installed vendor runner is an untyped external boundary. It executes
        // the handlers emitted by the real generated extension, not a copied hook.
        const { ExtensionRunner } = await import(alias.replace('pi-ai', 'pi-coding-agent'));
        const requestHandlers = new Map(handlers);
        if (!bound) requestHandlers.delete('before_provider_request');
        const runner = new ExtensionRunner([{ path: prepared.extensionPath, handlers: requestHandlers }], {}, params.directory ?? process.cwd(), {}, {});
        const errors: unknown[] = [];
        runner.onError((error: unknown) => errors.push(error));
        const outgoing: unknown = await runner.emitBeforeProviderRequest(payload);
        expect(errors).toEqual([]);
        return outgoing;
      },
      async dispose() {
        for (const handler of handlers.get('session_shutdown') ?? []) await handler({});
        await prepared.dispose();
      } };
  } catch (error) {
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({});
    await prepared.dispose();
    throw error;
  }
}

describe('Pi parameter documents through installed provider serializers', () => {
  const network = vi.fn(async () => { throw new Error('Network prohibited in schema contract'); });
  let loaded: Awaited<ReturnType<typeof loadExtension>>;
  let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
  let root: string;
  let native: ReturnType<typeof resolveSessionNativeToolDescriptors>;
  let external: ReturnType<typeof projectExecutablePluginToolCatalog>;

  beforeAll(async () => {
    vi.stubGlobal('fetch', network);
    root = mkdtempSync(join(tmpdir(), 'happier-pi-schema-contract-'));
    native = resolveSessionNativeToolDescriptors({ accountSettings: {}, sessionId: 'schema-session',
      memoryRecallGuidanceEnabled: false, isServerFeatureEnabled: () => true });
    const pluginId = 'acme.pi-schema-contract';
    const schemas = ['$defs', 'definitions'].map(keyword => ({
      type: 'object' as const,
      properties: { label: { $ref: `#/${keyword}/label~1with~0escape` },
        tree: { $ref: `#/${keyword}/node` } },
      required: ['label', 'tree'],
      [keyword]: { 'label/with~escape': { type: 'string', minLength: 1 },
        node: { type: 'object', properties: { value: { type: 'integer' },
          children: { type: 'array', items: { $ref: `#/${keyword}/node` } } },
        required: ['value'], additionalProperties: false } },
    }));
    fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
        actions: schemas.map((inputSchema, i) => ({ id: `read${i}`, title: 'Read schema', scopes: ['global'],
          surfaces: ['mcp'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema,
          tool: { name: `authored${i}`, title: 'Authored schema' } })),
      } }),
      files: { 'daemon.mjs': 'export function activate(api) { for (const id of ["read0", "read1"]) api.actions.register(id, async input => input); }' },
    }] });
    await fixture.registry.activateContributionsOnDemand(schemas.map((_, i) => ({ pluginId, family: 'actions' as const, localId: `read${i}` })));
    const admitted = projectExecutablePluginToolCatalog(fixture.registry);
    external = admitted;
    expect(admitted.map(tool => tool.name).sort()).toEqual(['authored0', 'authored1']);
    const serverPath = join(root, 'mcp.mjs');
    writeFileSync(serverPath, `import { createInterface } from 'node:readline';
      const tools = ${JSON.stringify(admitted)};
      createInterface({input: process.stdin}).on('line', line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        const result = m.method === 'initialize' ? {protocolVersion:'2024-11-05', capabilities:{tools:{}}}
          : {tools};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
      });`);
    const inline = projectMcpToolInputJsonSchema(zodSchemaToJsonSchemaObject(getActionSpec('settings.get').inputSchema));
    loaded = await loadExtension({ config: { v: 1, directory: root, systemPrompt: '',
      tools: [...native.filter(tool => ['settings_get', 'session_board_item_upsert'].includes(tool.name)),
        { name: 'inline_control', title: 'Inline control', description: '', inputSchema: JSON.parse(JSON.stringify(inline)) }],
      launch: { executablePath: process.execPath, argsPrefix: [] } },
      mcpServers: { authored: { command: process.execPath, args: [serverPath] } },
    });
    expect(loaded.tools.map(tool => tool.name).sort()).toEqual([
      'session_board_item_upsert', 'settings_get', 'inline_control', 'mcp__authored__authored0', 'mcp__authored__authored1',
    ].sort());
    console.info('Pi native parameter presentation JSON characters', native.filter(tool =>
      loaded.tools.some(registered => registered.name === tool.name)).map(tool => ({
      name: tool.name, shared: JSON.stringify(tool.inputSchema).length,
      pi: JSON.stringify(loaded.tools.find(registered => registered.name === tool.name)!.parameters).length,
    })));
  });

  afterAll(async () => {
    try { await loaded?.dispose(); await fixture?.dispose(); }
    finally { if (root) rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); }
  });

  it.each(aliases)('%s keeps native, inline and admitted recursive MCP schemas resolvable for Anthropic', async alias => {
    const outgoing = await anthropicParameters(alias, loaded.tools, loaded);
    const board = getActionSpec('session.board.item.upsert');
    const example = JSON.parse(board.examples!.mcp!.argsExample!);
    expect(board.inputSchema.safeParse(example).success).toBe(true);
    const unresolved: string[] = [];
    for (const tool of outgoing) {
      expect(tool.strict).toBeUndefined();
      let validate;
      try { validate = new Ajv2020({ strict: false, validateFormats: false }).compile(tool.input_schema); }
      catch (error) { unresolved.push(`${tool.name}: ${String(error)}`); continue; }
      if (tool.name === 'session_board_item_upsert') {
        expect(validate(example)).toBe(true);
        expect(validate({ itemId: 'incomplete' })).toBe(false);
      } else if (tool.name.startsWith('mcp__')) {
        expect(validate({ label: 'valid', tree: { value: 1, children: [{ value: 2 }] } })).toBe(true);
        expect(validate({ label: '', tree: { value: 1 } })).toBe(false);
        expect(validate({ label: 'valid', tree: { value: 1, children: [{ value: 'bad' }] } })).toBe(false);
      }
    }
    expect(unresolved).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it('refuses a detached native definition map instead of advertising a dangling reference', async () => {
    const source = native.find(tool => tool.name === 'settings_get')!;
    const schema = source.inputSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Missing native schema');
    expect(schema).toHaveProperty('$defs');
    const registered: Tool[] = [];
    await expect(loadExtension({ config: { v: 1, directory: root, systemPrompt: '',
      tools: [{ name: 'valid_first', title: 'Valid', description: '', inputSchema: { type: 'object' } },
        { ...source, inputSchema: { ...schema, $defs: {} } }],
      launch: { executablePath: process.execPath, argsPrefix: [] } },
    }, tool => registered.push(tool))).rejects.toThrow(/reference/i);
    expect(registered).toEqual([]);
  });

  it.each(aliases)('%s preserves the inline nonrecursive control before any reference lowering', async alias => {
    const control = loaded.tools.find(tool => tool.name === 'inline_control')!;
    const [outgoing] = await anthropicParameters(alias, [control]);
    expect(() => new Ajv2020({ strict: false, validateFormats: false }).compile(outgoing!.input_schema)).not.toThrow();
  });

  it.each(aliases)('%s validates recursive tool arguments through its own native validator', async alias => {
    const { validateToolArguments } = await import(alias);
    for (const tool of loaded.tools.filter(tool => tool.name.startsWith('mcp__'))) {
      const input = { label: 'valid', tree: { value: 1, children: [{ value: 2 }] } };
      const call = { type: 'toolCall', id: 'plugin-call', name: tool.name, arguments: input };
      expect(validateToolArguments(tool, call)).toEqual(input);
      expect(() => validateToolArguments(tool, { ...call, arguments: {
        label: 'valid', tree: { value: 1, children: [{ value: 'bad' }] },
      } })).toThrow();
    }
  });

  it.each(aliases)('%s preserves the original shared documents in OpenAI Responses, Chat and Google serializers', async alias => {
    const original = native.filter(tool => ['settings_get', 'session_board_item_upsert'].includes(tool.name));
    for (const source of original) {
      expect(loaded.tools.find(tool => tool.name === source.name)!.parameters).toEqual(source.inputSchema);
    }
    for (const source of external) {
      expect(loaded.tools.find(tool => tool.name === `mcp__authored__${source.name}`)!.parameters).toEqual(source.inputSchema);
    }
    for (const api of ['openai-responses', 'openai-completions'] as const) {
      const { stream } = await import(`${alias}/api/${api}`);
      let captured: unknown;
      await stream({ ...anthropicModel, api, provider: 'openai', id: 'gpt-4.1' }, { messages, tools: loaded.tools }, {
        apiKey: 'schema-contract-placeholder',
        async onPayload(payload: unknown) {
          captured = await loaded.payload(alias, payload);
          expect(captured).toBe(payload);
          throw new Error('Payload captured before network');
        },
      }).result();
      // Exact vendor request arms, observed only after the installed conversion.
      const outgoing = (captured as { tools: { parameters?: object; function?: { parameters: object } }[] }).tools;
      expect(outgoing.map(tool => tool.parameters ?? tool.function?.parameters)).toEqual(loaded.tools.map(tool => tool.parameters));
    }
    const { convertTools } = await import(`${alias}/api/google-shared`);
    const googlePayload = { tools: convertTools(loaded.tools) };
    expect(await loaded.payload(alias, googlePayload)).toBe(googlePayload);
    const google = googlePayload.tools![0]!.functionDeclarations;
    expect(google.map(tool => tool.parametersJsonSchema)).toEqual(loaded.tools.map(tool => tool.parameters));
    expect(network).not.toHaveBeenCalled();
  });

  it('retains reference siblings, literal JSON, boolean targets and root-recursive inputs', async () => {
    const inputSchema = { type: 'object', required: ['label'], properties: {
      label: { $ref: '#/$defs/label', maxLength: 3 },
      child: { $ref: '#' },
      denied: { $ref: '#/$defs/never' },
      arbitrary: { default: { $ref: 'literal data, not a schema reference' } },
    }, $defs: { label: { type: 'string', minLength: 1 }, never: false } };
    const extension = await loadExtension({ config: { v: 1, directory: root, systemPrompt: '',
      tools: [{ name: 'arbitrary_schema', title: 'Schema', description: '', inputSchema }],
      launch: { executablePath: process.execPath, argsPrefix: [] } },
    });
    try {
      const [tool] = await anthropicParameters('pi-ai-0821', extension.tools, extension);
      const validate = new Ajv2020({ strict: false }).compile(tool!.input_schema);
      expect(validate({ label: 'ok', child: { label: 'kid' }, arbitrary: { $ref: 'any data' } })).toBe(true);
      for (const input of [{ label: '' }, { label: 'long' }, { label: 'ok', child: { label: 2 } }, { label: 'ok', denied: 1 }]) {
        expect(validate(input)).toBe(false);
      }
      expect(JSON.stringify(tool!.input_schema)).toContain('literal data, not a schema reference');
    } finally { await extension.dispose(); }
  });

  it('also repairs the already-recursive Board projection used before shared-reference export', async () => {
    const spec = getActionSpec('session.board.item.upsert');
    const inputSchema = JSON.parse(JSON.stringify(projectMcpToolInputJsonSchema(zodSchemaToJsonSchemaObject(spec.inputSchema))));
    const raw: Tool = { name: 'previous_board', description: '', parameters: inputSchema };
    const [previous] = await anthropicParameters('pi-ai-0821', [raw]);
    let previousCompiled = true;
    try { new Ajv2020({ strict: false, validateFormats: false }).compile(previous!.input_schema); }
    catch { previousCompiled = false; }
    console.info('Pre-DIAG172 recursive Board serializer control', { previousCompiled });
    const extension = await loadExtension({ config: { v: 1, directory: root, systemPrompt: '',
      tools: [{ name: raw.name, title: 'Previous Board', description: '', inputSchema }],
      launch: { executablePath: process.execPath, argsPrefix: [] } },
    });
    try {
      const [outgoing] = await anthropicParameters('pi-ai-0821', extension.tools, extension);
      const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(outgoing!.input_schema);
      expect(validate(JSON.parse(spec.examples!.mcp!.argsExample!))).toBe(true);
      expect(validate({ itemId: 'incomplete' })).toBe(false);
    } finally { await extension.dispose(); }
  });

  it.each([false, true])('preserves a document-root reference with metadata and an explicit object type: %s', async explicitType => {
    const extension = await loadExtension({ config: { v: 1, directory: root, systemPrompt: '',
      tools: [{ name: 'root_reference', title: 'Root reference', description: '', inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema', description: 'Authored root',
        ...(explicitType ? { type: 'object' } : {}),
        $ref: '#/definitions/input', definitions: { input: {
          type: 'object', properties: { label: { type: 'string', minLength: 1 } }, required: ['label'],
        } },
      } }], launch: { executablePath: process.execPath, argsPrefix: [] } },
    });
    try {
      const [outgoing] = await anthropicParameters('pi-ai-0821', extension.tools, extension);
      const validate = new Ajv2020({ strict: false }).compile(outgoing!.input_schema);
      expect(validate({ label: 'kept' })).toBe(true);
      expect(validate({ label: '' })).toBe(false);
      expect(validate({})).toBe(false);
    } finally { await extension.dispose(); }
  });

  it.each(aliases)('%s repairs root constraint siblings only with the generated request hook bound, including OAuth names', async alias => {
    const inputSchema = { type: 'object', propertyNames: { pattern: '^[a-z]+$' },
      $ref: '#/$defs/input', $defs: { input: { type: 'object',
        properties: { label: { type: 'string', minLength: 1 }, child: { $ref: '#/$defs/input' } },
        required: ['label'] } } };
    const extension = await loadExtension({ config: { v: 1, directory: root, systemPrompt: '',
      tools: [{ name: 'authored_root', title: 'Root', description: '', inputSchema }],
      launch: { executablePath: process.execPath, argsPrefix: [] } },
    });
    // Pi's registry includes native/discovered tools as well as Happier tools.
    // Read is OAuth-normalized by the real serializer; no new registry may own it.
    extension.tools.push({ name: 'read', description: 'Native read', parameters: inputSchema });
    extension.setActiveTools([...extension.getActiveTools(), 'read']);
    const validate = (schema: object) => new Ajv2020({ strict: false }).compile(schema);
    try {
      for (const oauth of [false, true]) {
        const unbound = await anthropicParameters(alias, extension.tools, extension, { bound: false, oauth });
        expect(validate(unbound[0]!.input_schema)({})).toBe(true);
        const outgoing = await anthropicParameters(alias, extension.tools, extension, { oauth });
        expect(outgoing.map(tool => tool.name)).toEqual(['authored_root', oauth ? 'Read' : 'read']);
        expect(outgoing.map(({ input_schema: _schema, ...metadata }) => metadata))
          .toEqual(unbound.map(({ input_schema: _schema, ...metadata }) => metadata));
        for (const tool of outgoing) {
          expect(tool.input_schema).toEqual(inputSchema);
          expect(tool.strict).toBeUndefined();
          const check = validate(tool.input_schema);
          expect(check({ label: 'ok', child: { label: 'nested' } })).toBe(true);
          for (const input of [{}, { label: '' }, { label: 'ok', BAD: true }, { label: 'ok', child: { label: '' } }]) {
            expect(check(input)).toBe(false);
          }
        }
      }
      // Strict sampling and vendor-owned tools without a registered schema are
      // outside the lossy arm; their complete request metadata stays untouched.
      const strictTool = { name: 'authored_root', strict: true, input_schema: { type: 'object' } };
      const vendorTool = { type: 'web_search_20250305', name: 'web_search' };
      const payload = { tools: [strictTool, vendorTool] };
      const repaired = await extension.payload(alias, payload) as typeof payload;
      expect(repaired.tools[0]).toBe(strictTool);
      expect(repaired.tools[1]).toBe(vendorTool);
      expect(network).not.toHaveBeenCalled();
    } finally { await extension.dispose(); }
  });

  it.each(aliases)('%s resolves schemas only from selected tools before OAuth name matching', async alias => {
    const inputSchema = { type: 'object', $ref: '#/$defs/input', $defs: { input: {
      type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'],
    } } };
    const inactiveSchema = { type: 'object', properties: { other: { type: 'string' } }, required: ['other'] };
    const extension = await loadExtension({ config: { v: 1, directory: root, systemPrompt: '',
      tools: [{ name: 'Read', title: 'Inactive extension Read', description: 'Requires other', inputSchema: inactiveSchema }],
      launch: { executablePath: process.execPath, argsPrefix: [] } },
    });
    const read: Tool = { name: 'read', description: 'Native read requiring path', parameters: inputSchema };
    extension.tools.push(read);
    extension.setActiveTools(['read']);
    try {
      for (const oauth of [false, true]) {
        const unbound = await anthropicParameters(alias, [read], extension, { bound: false, oauth });
        expect(new Ajv2020({ strict: false }).compile(unbound[0]!.input_schema)({})).toBe(true);
        const outgoing = await anthropicParameters(alias, [read], extension, { oauth });
        expect(outgoing.map(tool => tool.name)).toEqual([oauth ? 'Read' : 'read']);
        expect(outgoing.map(({ input_schema: _schema, ...metadata }) => metadata))
          .toEqual(unbound.map(({ input_schema: _schema, ...metadata }) => metadata));
        expect(outgoing[0]!.input_schema).toEqual(inputSchema);
        const validate = new Ajv2020({ strict: false }).compile(outgoing[0]!.input_schema);
        expect(validate({ path: '/selected' })).toBe(true);
        expect(validate({ other: 'inactive' })).toBe(false);
        expect(validate({})).toBe(false);
      }
      // Selection is read per request; activating the extension keeps its exact
      // identity and parameters rather than a stale native-tool association.
      extension.setActiveTools(['Read']);
      for (const oauth of [false, true]) {
        const outgoing = await anthropicParameters(alias, [extension.tools[0]!], extension, { oauth });
        expect(outgoing[0]!.name).toBe('Read');
        expect(outgoing[0]!.input_schema).toEqual(inactiveSchema);
      }
      expect(network).not.toHaveBeenCalled();
    } finally { await extension.dispose(); }
  });

  it('keeps an invalid external schema from leaving tools registered on a closed MCP connection', async () => {
    const brokenPath = join(root, 'broken-mcp.mjs');
    writeFileSync(brokenPath, `import { createInterface } from 'node:readline';
      createInterface({input:process.stdin}).on('line', line => {
        const m=JSON.parse(line); if(m.id===undefined)return;
        const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}
          :{tools:[{name:'first',inputSchema:{type:'object',properties:{}}},
            {name:'broken',inputSchema:{type:'object',properties:{value:{$ref:'#/$defs/detached'}}}}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
      });`);
    const extension = await loadExtension({ directory: root, mcpServers: {
      broken: { command: process.execPath, args: [brokenPath] },
      healthy: { command: process.execPath, args: [join(root, 'mcp.mjs')] },
    } });
    try {
      const expected = ['mcp__healthy__authored0', 'mcp__healthy__authored1'];
      expect(extension.tools.map(tool => tool.name)).toEqual(expected);
      expect(extension.getActiveTools()).toEqual(expected);
    } finally { await extension.dispose(); }
  });
});
