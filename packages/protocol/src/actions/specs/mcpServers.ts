import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 as inputs, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type McpServerActionIdV1 } from '../../mcp/servers/actionSchemasV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { z } from 'zod/mini';
import type { ValueRefV1 } from '../../valueRefs/valueRefV1.js';
import { parseMcpServerImportV1, type ImportedMcpServerDraftV1 } from '../../mcp/servers/import/parseMcpServerImportV1.js';
import { prepareDetectedMcpServerImportV1 } from '../../mcp/servers/import/mcpServerImportV1.js';
import { ReachRulesChangeV1Schema, DEFAULT_CREATE_REACH_CHANGE_V1 as defaultMcpWhere } from '../../reach/reachRulesChangeV1.js';
import { McpRemoteUrlV1Schema } from '../../mcp/remoteUrlV1.js';
import { RegistryItemPointerV1Schema } from '../../registries/registryItemsV1.js';
import { McpServerCatalogEntryV1Schema, McpServerToolSettingsPatchV1Schema, McpServerToolPolicyV1Schema,
  type McpServerCatalogEntryV1, type McpServerConfigOverrideV1 } from '../../mcp/servers/settingsV1.js';
import { ReachPlaceV1Schema } from '../../reach/reachPlaceV1.js';
import { DaemonMcpServersDetectErrorCodeSchema, DaemonMcpServersTestErrorCodeSchema } from '../../mcp/servers/daemonRpcV1.js';
import { MCP_SERVER_CATALOG_SUGGESTIONS_V1 } from '../../mcp/servers/catalogSuggestionsV1.js';

// Review is presentation data, never executable input. In particular imported
// config text, literal values and OAuth bearers stay in their live continuation.
const reviewedOverride = z.strictObject({ where: ReachPlaceV1Schema, command: z.optional(z.string()), arguments: z.optional(z.array(z.string())),
  address: z.optional(McpRemoteUrlV1Schema), workingFolder: z.optional(z.string()), environment: z.array(z.string()), headers: z.array(z.string()) });
const reviewedServer = z.strictObject({
  name: z.string(), title: z.optional(z.string()), transport: z.enum(['stdio', 'http', 'sse']),
  command: z.optional(z.string()), arguments: z.optional(z.array(z.string())), address: z.optional(McpRemoteUrlV1Schema),
  workingFolder: z.optional(z.string()), environment: z.array(z.string()), headers: z.array(z.string()),
  where: z.optional(ReachRulesChangeV1Schema), toolPolicy: z.optional(McpServerToolPolicyV1Schema), signIn: z.optional(z.literal('OAuth')),
  configOverrides: z.optional(z.array(reviewedOverride)),
});
const mcpReviewInput = z.strictObject({
  serverId: z.optional(z.string().check(z.minLength(1))), servers: z.optional(z.array(reviewedServer)),
  name: z.optional(z.string()), title: z.optional(z.string()),
  from: z.optional(RegistryItemPointerV1Schema), inputs: z.optional(z.array(z.string())),
  address: z.optional(McpRemoteUrlV1Schema),
  where: z.optional(ReachRulesChangeV1Schema), machineId: z.optional(z.string().check(z.minLength(1))), directory: z.optional(z.string()),
  default: McpServerToolSettingsPatchV1Schema.shape.default, tools: McpServerToolSettingsPatchV1Schema.shape.tools,
  removeBindings: z.optional(z.boolean()), stepUp: z.optional(z.boolean()), dryRun: z.optional(z.boolean()),
  oauthApp: z.optional(z.enum(['set', 'remove'])), clientId: z.optional(z.string().check(z.minLength(1))),
  configOverrides: z.optional(z.array(reviewedOverride)),
});

function mcpReviewSchema(id: McpServerActionIdV1) {
  if (id === 'mcp.servers.tools.set' || id === 'mcp.servers.signIn.start') return z.required(mcpReviewInput, { serverId: true });
  if (id === 'mcp.servers.delete') return z.required(mcpReviewInput, { serverId: true, removeBindings: true });
  if (id === 'mcp.servers.duplicate') return z.required(mcpReviewInput, { serverId: true });
  if (id === 'mcp.servers.import') return z.required(mcpReviewInput, { servers: true, dryRun: true });
  if (id === 'mcp.found.adopt') return z.required(mcpReviewInput, { servers: true, machineId: true });
  const review = id === 'mcp.servers.test' ? z.required(mcpReviewInput, { machineId: true, directory: true }) : mcpReviewInput;
  return review.check(z.refine(value => value.servers !== undefined || value.from !== undefined || id === 'mcp.servers.test' && value.serverId !== undefined, 'Missing reviewed MCP operation'));
}

function reviewServer(server: Omit<McpServerCatalogEntryV1, 'id' | 'createdAt' | 'updatedAt'> | ImportedMcpServerDraftV1) {
  const folder = server.stdio?.cwd;
  return { name: server.name, ...(server.title ? { title: server.title } : {}), transport: server.transport,
    ...(server.stdio ? { command: server.stdio.command, arguments: server.stdio.args,
      ...(folder ? { workingFolder: folder.t === 'path' ? folder.path : 'Session folder' } : {}) } : {}),
    ...(server.remote && McpRemoteUrlV1Schema.safeParse(server.remote.url).success ? { address: server.remote.url } : {}),
    environment: Object.keys(server.env), headers: Object.keys(server.remote?.headers ?? {}),
    ...('tools' in server && server.tools ? { toolPolicy: server.tools } : {}),
    ...('configOverrides' in server && server.configOverrides ? { configOverrides: server.configOverrides.map(reviewOverride) } : {}),
    ...('auth' in (server.remote ?? {}) && readRecord(server.remote).auth ? { signIn: 'OAuth' as const } : {}) };
}

function reviewOverride(override: McpServerConfigOverrideV1) {
  const folder = override.stdio?.cwd;
  return { where: override.target, command: override.stdio?.command, arguments: override.stdio?.args, address: override.remote?.url,
    workingFolder: folder ? folder.t === 'path' ? folder.path : 'Session folder' : undefined,
    environment: Object.keys(override.envPatch ?? {}), headers: Object.keys(override.remote?.headersPatch ?? {}) };
}

function projectMcpApprovalInput(id: McpServerActionIdV1, raw: unknown) {
  const input = inputs[id].parse(raw);
  if (id === 'mcp.servers.import') {
    const value = inputs[id].parse(input);
    const parsed = parseMcpServerImportV1(value.source.kind === 'paste' ? value.source.text : value.source.url);
    const address = value.source.kind === 'link' && parsed.servers.length === 0 ? McpRemoteUrlV1Schema.safeParse(value.source.url) : null;
    return mcpReviewSchema(id).parse({ servers: parsed.servers.map(reviewServer), where: value.where ?? defaultMcpWhere, dryRun: value.dryRun,
      ...(address?.success ? { address: address.data } : {}) });
  }
  if (id === 'mcp.found.adopt') {
    const value = inputs[id].parse(input);
    return mcpReviewSchema(id).parse({ servers: prepareDetectedMcpServerImportV1(value.items, value.machineId).servers.map(reviewServer),
      machineId: value.machineId, where: value.where ?? defaultMcpWhere });
  }
  if (id === 'mcp.servers.signIn.start') {
    const value = inputs[id].parse(input);
    return mcpReviewSchema(id).parse({ serverId: value.serverId, stepUp: value.stepUp,
      ...(value.client === null ? { oauthApp: 'remove' }
        : value.client ? { oauthApp: 'set', clientId: value.client.clientId } : {}) });
  }
  const value = readRecord(input);
  const entry = value.entry;
  const servers = entry ? [reviewServer(McpServerCatalogEntryV1Schema.parse(entry))] : undefined;
  // Canonical schemas above admitted each variant; narrow at its owning schema
  // rather than reading arbitrary nested configuration as review authority.
  if (id === 'mcp.servers.create') {
    const create = inputs[id].parse(input);
    if ('entries' in create) return mcpReviewSchema(id).parse({ servers: create.entries.map(item => ({ ...reviewServer(item.entry), where: item.where ?? defaultMcpWhere })) });
    if ('suggestionId' in create) {
      const suggestion = MCP_SERVER_CATALOG_SUGGESTIONS_V1.find(suggestion => suggestion.id === create.suggestionId)!;
      return mcpReviewSchema(id).parse({ servers: [reviewServer({ name: suggestion.id, title: suggestion.title,
        transport: 'http', remote: { url: suggestion.url, headers: {}, ...(suggestion.oauth ? { auth: { kind: 'oauth' } as const } : {}) }, env: {} })],
        where: create.where ?? defaultMcpWhere });
    }
  }
  const overrides = id === 'mcp.servers.update' ? inputs[id].parse(input) : null;
  const configuration = overrides && 'configOverrides' in overrides ? overrides.configOverrides : undefined;
  return mcpReviewSchema(id).parse({
    serverId: value.serverId ?? (entry ? readRecord(entry).id : undefined), servers,
    name: value.name, title: value.title,
    from: value.from ? readRecord(value.from).registry : undefined, inputs: value.inputs ? Object.keys(readRecord(value.inputs)) : undefined,
    where: value.where ?? (id === 'mcp.servers.create' || id === 'mcp.servers.duplicate' ? defaultMcpWhere : undefined),
    machineId: value.machineId, directory: value.directory, default: value.default, tools: value.tools,
    removeBindings: value.removeBindings, stepUp: value.stepUp,
    ...(configuration ? { configOverrides: configuration.map(reviewOverride) } : {}),
  });
}

const mcpReviewFields: NonNullable<PreNormalizedActionSpec['inputHints']>['fields'] = [
  { path: 'serverId', title: 'MCP server', widget: 'text' },
  { path: 'oauthApp', title: 'OAuth app', widget: 'select', options: [
    { value: 'set', label: 'Set or replace OAuth app', labelKey: 'capabilities.mcpSignIn.reviewSetApp' },
    { value: 'remove', label: 'Remove OAuth app', labelKey: 'capabilities.mcpSignIn.reviewRemoveApp' },
  ] },
  { path: 'clientId', title: 'Client ID', widget: 'text' },
  { path: 'name', title: 'Server name', widget: 'text' }, { path: 'title', title: 'Server title', widget: 'text' },
  { path: 'servers', title: 'Server configuration', widget: 'json' },
  { path: 'from', title: 'Registry item', widget: 'json' },
  { path: 'inputs', title: 'Configured inputs', widget: 'text_list', listSeparator: 'comma' },
  { path: 'address', title: 'Import address', widget: 'url' },
  { path: 'default', title: 'Default tool policy', widget: 'select', options: [
    { value: 'ask', label: 'Ask' }, { value: 'allow_read_only', label: 'Allow read-only' }, { value: 'allow_all', label: 'Allow all' },
  ] },
  { path: 'tools', title: 'Tool policy changes', widget: 'json' },
  { path: 'where.write.place', title: 'Where', widget: 'json' },
  { path: 'where.write.state', title: 'Change', widget: 'select', options: [
    { value: 'on', label: 'Turn on' }, { value: 'off', label: 'Turn off' }, { value: 'inherit', label: 'Use inherited rules' },
  ] },
  { path: 'where.write.agentId', title: 'Agent', widget: 'text' },
  { path: 'where.rules', title: 'Where', widget: 'json' },
  { path: 'machineId', title: 'Where', widget: 'text' }, { path: 'directory', title: 'Working folder', widget: 'text' },
  { path: 'configOverrides', title: 'Configuration on machines', widget: 'json' },
  { path: 'removeBindings', title: 'Remove rules', widget: 'boolean' },
  { path: 'stepUp', title: 'More access', widget: 'boolean' }, { path: 'dryRun', title: 'Preview only', widget: 'boolean' },
];

function mcpCliValueRefs(values: readonly string[] | undefined): Record<string, ValueRefV1> {
  return Object.fromEntries((values ?? []).map(value => {
    const separator = value.indexOf('=');
    if (separator <= 0) throw Object.assign(new Error('Supply each value as NAME=value.'), { code: 'invalid_arguments' });
    const key = value.slice(0, separator);
    const text = value.slice(separator + 1);
    return [key, text.startsWith('secret:') ? { t: 'savedSecret', secretId: text.slice(7) }
      : { t: 'literal', v: text.startsWith('text:') ? text.slice(5) : text }];
  }));
}

const mcpCreateCliInput = z.strictObject({
  name: z.string().check(z.minLength(1)), title: z.optional(z.string()), transport: z.optional(z.enum(['stdio', 'http', 'sse'])),
  command: z.optional(z.string().check(z.minLength(1))), arg: z.optional(z.array(z.string())), url: z.optional(z.string().check(z.minLength(1))),
  env: z.optional(z.array(z.string())), header: z.optional(z.array(z.string())),
  expectedRevision: z.optional(z.union([z.number().check(z.int(), z.nonnegative()), z.literal('absent')])),
  // The terminal stamps these before binding; canonical --input-json remains complete input.
  entryId: z.optional(z.string().check(z.minLength(1))), nowMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}).check(z.superRefine((input, context) => {
  const remote = input.transport !== 'stdio' && input.url !== undefined;
  if (remote ? input.command !== undefined || input.arg !== undefined : !input.command || input.url !== undefined || input.header !== undefined) {
    context.addIssue({ code: 'custom', message: 'Supply a local command or a remote URL with its matching transport.' });
  }
}));

const mcpObservationErrorCode = z.union([DaemonMcpServersDetectErrorCodeSchema, DaemonMcpServersTestErrorCodeSchema]);
// Public approval reads use this same observation owner. Preserve reviewed
// policy/control choices, but never copy executable config or credential values.
const mcpObservationControls = z.object(z.pick(mcpReviewInput, {
  default: true, tools: true, where: true, directory: true,
  removeBindings: true, stepUp: true, dryRun: true, oauthApp: true, clientId: true,
}).shape);

function projectMcpObservation(input: unknown): unknown {
  const value = readRecord(input);
  const entry = readRecord(value.entry);
  const controls = mcpObservationControls.safeParse(value);
  const errorCode = value.ok === false && typeof value.errorCode === 'string' ? mcpObservationErrorCode.safeParse(value.errorCode) : null;
  return {
    ...(controls.success ? readRecord(projectNativeJsonValueForTransport(controls.data)) : {}),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.serverId === 'string' ? { serverId: value.serverId } : typeof entry.id === 'string' ? { serverId: entry.id } : {}),
    ...(Array.isArray(value.entries) ? { serverIds: value.entries
      .map(item => readRecord(readRecord(item).entry).id).filter(id => typeof id === 'string') } : {}),
    ...(typeof value.machineId === 'string' ? { machineId: value.machineId } : {}),
    ...(typeof value.expectedRevision === 'number' || value.expectedRevision === 'absent' ? { expectedRevision: value.expectedRevision } : {}),
    ...(typeof value.revision === 'number' || value.revision === 'absent' ? { revision: value.revision } : {}),
    ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
    // The public failure reader admits the response schema. Keep Test's
    // numeric timing and use only the closed code as the safe error text.
    ...(errorCode?.success ? { errorCode: errorCode.data, error: errorCode.data } : {}),
    ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
    ...(typeof value.toolCount === 'number' ? { toolCount: value.toolCount } : {}),
  };
}
function mcpSpec<TId extends McpServerActionIdV1>(id: TId, title: string, summary: string, options: Readonly<{
  read?: boolean; danger?: boolean; machine?: boolean; confirm?: boolean; direct?: boolean;
}>): PreNormalizedActionSpec & Readonly<{ id: TId; inputSchema: (typeof inputs)[TId]; outputSchema: (typeof outputs)[TId] }> {
  return {
    id, approvalPolicy: options.confirm ? { uiConfirmation: 'policy' } : options.direct ? { uiConfirmation: 'direct' } : {},
    approval: { result: options.danger ? 'required' : 'none' }, title, safety: options.danger ? 'danger' : 'safe', sideEffectClass: options.read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: options.machine ? 'machine' : 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id], inputHints: { description: summary, fields: [] },
    projectObservationInput: projectMcpObservation, projectObservationOutput: projectMcpObservation,
    ...(options.danger ? { approvalPresentation: { summary: () => null, inputSchema: mcpReviewSchema(id),
      inputHints: { description: summary, fields: mcpReviewFields },
      projectInput: (raw: unknown) => projectMcpApprovalInput(id, raw), retainInputOnSettlement: true as const } } : {}),
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  };
}
function createMcpServerActionSpecsV1() {
  return [
  { ...mcpSpec('mcp.servers.signIn.start', 'Sign in to MCP server',
    'Sign in once to use this remote server from your machines.', { danger: true, direct: true }),
    approvalResultCustody: 'live_only' as const,
    approvalInputCustody: 'live_only' as const,
    inputHints: { fields: [{ path: 'serverId', title: 'MCP server', widget: 'text' as const },
      { path: 'client.clientId', title: 'Client ID', widget: 'text' as const },
      { path: 'client.clientSecret', title: 'Client secret', widget: 'secret' as const }] },
    cli: { acceptsServerId: true, inputSchema: z.strictObject({ itemId: z.string().check(z.minLength(1)), stepUp: z.optional(z.boolean()),
      clientId: z.optional(z.string().check(z.trim(), z.minLength(1))), clientSecret: z.optional(z.string().check(z.minLength(1))),
      removeClient: z.optional(z.boolean()) }).check(z.superRefine((value, context) => {
        if (value.clientSecret !== undefined && value.clientId === undefined || value.removeClient && (value.clientId !== undefined || value.clientSecret !== undefined)) {
          context.addIssue({ code: 'custom', message: 'Supply a Client ID with an optional secret, or remove the saved app.' });
        }
      })),
      inputHints: { fields: [{ path: 'clientId', title: 'Client ID', widget: 'text' as const },
        { path: 'clientSecret', title: 'Client secret', widget: 'secret' as const }] },
      bindInput: (value: unknown) => { const input = readRecord(value); return { serverId: input.itemId,
        ...(input.stepUp === undefined ? {} : { stepUp: input.stepUp }),
        ...(input.removeClient ? { client: null } : input.clientId !== undefined ? { client: { clientId: input.clientId,
          ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }) } } : {}) }; },
      commands: [{ path: ['mcp', 'servers', 'sign-in'], positionals: ['itemId'], visibility: 'canonical' as const }] } },
  mcpSpec('mcp.servers.list', 'List MCP servers',
    'See the MCP servers saved in your account.', { read: true }),
  mcpSpec('mcp.servers.read', 'Read MCP server',
    'See one MCP server: how it starts and where it is used.', { read: true }),
  { ...mcpSpec('mcp.servers.tools.list', 'List MCP server tools',
    'See the tools checked for a server, their settings and approximate cost.', { read: true }),
    cli: { acceptsServerId: true, inputSchema: z.strictObject({ itemId: z.string().check(z.minLength(1)) }),
      bindInput: (value: unknown) => ({ serverId: readRecord(value).itemId }),
      commands: [{ path: ['mcp', 'servers', 'tools'], positionals: ['itemId'], visibility: 'canonical' as const },
        { path: ['mcp', 'servers', 'tools', 'list'], positionals: ['itemId'], visibility: 'alias' as const }] } },
  { ...mcpSpec('mcp.servers.tools.set', 'Set MCP server tool settings',
    'Change a server default or individual tool settings. The previous settings can be restored.', { danger: true, direct: true }),
    cli: { acceptsServerId: true, inputSchema: z.strictObject({ itemId: z.string().check(z.minLength(1)),
      operation: z.enum(['set', 'default']), toolName: z.string().check(z.minLength(1)),
      setting: z.optional(z.enum(['off', 'ask', 'allow', 'inherit'])) }).check(z.superRefine((input, context) => {
      if (input.operation === 'set' && input.setting === undefined) {
        context.addIssue({ code: 'custom', path: ['setting'], message: 'Supply a tool setting.' });
      }
      if (input.operation === 'default' && (!['ask', 'read-only', 'all'].includes(input.toolName) || input.setting !== undefined)) {
        context.addIssue({ code: 'custom', path: ['toolName'], message: 'Supply one default: ask, read-only or all.' });
      }
    })),
      bindInput: (value: unknown) => {
        const input = readRecord(value);
        return input.operation === 'set' && typeof input.toolName === 'string'
          ? { serverId: input.itemId, tools: { [input.toolName]: input.setting } }
          : { serverId: input.itemId, default: input.toolName === 'read-only' ? 'allow_read_only'
            : input.toolName === 'all' ? 'allow_all' : input.toolName };
      },
      commands: [{ path: ['mcp', 'servers', 'tools', 'set'], positionals: ['itemId', 'operation', 'toolName', 'setting'],
        visibility: 'canonical' as const }] } },
  { ...mcpSpec('mcp.servers.create', 'Add MCP server',
    'Add an MCP server, which gives agents extra tools.', { danger: true, direct: true }),
    inputHints: { fields: [{ path: 'suggestionId', title: 'Suggested MCP server', widget: 'select' as const,
      options: MCP_SERVER_CATALOG_SUGGESTIONS_V1.map(suggestion => ({ value: suggestion.id, label: suggestion.title,
        description: suggestion.description })) }] },
    cli: { acceptsServerId: true, inputSchema: mcpCreateCliInput,
      bindInput: (value: unknown) => {
        const input = mcpCreateCliInput.parse(value);
        const transport = input.transport ?? (input.url ? 'http' : 'stdio');
        return { expectedRevision: input.expectedRevision, entry: { id: input.entryId, name: input.name,
          ...(input.title === undefined ? {} : { title: input.title }), transport,
          ...(transport === 'stdio' ? { stdio: { command: input.command, args: input.arg ?? [] } }
            : { remote: { url: input.url, headers: mcpCliValueRefs(input.header) } }),
          env: mcpCliValueRefs(input.env), createdAt: input.nowMs, updatedAt: input.nowMs } };
      },
      commands: [{ path: ['mcp', 'servers', 'add'], positionals: ['name'], visibility: 'canonical' as const }] } },
  mcpSpec('mcp.servers.update', 'Update MCP server',
    'Change how an MCP server starts or signs in.', { danger: true, direct: true }),
  { ...mcpSpec('mcp.servers.duplicate', 'Duplicate MCP server',
    'Make a copy of an MCP server to adjust.', { danger: true, direct: true }),
    cli: { acceptsServerId: true, inputSchema: z.strictObject({ itemId: z.string().check(z.minLength(1)) }),
      bindInput: (value: unknown) => ({ serverId: readRecord(value).itemId }),
      commands: [{ path: ['mcp', 'servers', 'duplicate'], positionals: ['itemId'], visibility: 'canonical' as const }] } },
  mcpSpec('mcp.servers.delete', 'Delete MCP server',
    'Remove an MCP server. Agents lose its tools everywhere it was used.', { danger: true, confirm: true }),
  { ...mcpSpec('mcp.servers.test', 'Test MCP server connection',
    'Start an MCP server on a machine and check that it answers with its tools.', { danger: true, machine: true, direct: true }),
    cli: { acceptsServerId: true,
      inputSchema: z.strictObject({ itemId: z.string().check(z.minLength(1)), directory: z.optional(z.string().check(z.minLength(1))),
        machineId: z.optional(z.string().check(z.minLength(1))) }),
      bindInput: (value: unknown) => { const input = readRecord(value); return { t: 'byId', serverId: input.itemId,
        directory: input.directory, machineId: input.machineId }; },
      commands: [{ path: ['mcp', 'servers', 'test'], positionals: ['itemId'], visibility: 'canonical' as const }] } },
  { ...mcpSpec('mcp.servers.import', 'Import MCP servers',
    'Review a config or install link and choose every named value before adding its servers.', { danger: true, direct: true }), approvalInputCustody: 'live_only' as const },
  { ...mcpSpec('mcp.found.adopt', 'Add a found MCP server',
    'Add a machine configuration after choosing its environment and header values.', { danger: true, direct: true }), approvalInputCustody: 'live_only' as const },
  { ...mcpSpec('mcp.found.list', 'Detect MCP servers on a machine',
    'Look for MCP servers already set up for the agents on a machine.', { read: true, machine: true }),
    cli: { acceptsServerId: true, flagAliases: [{ path: 'providers', aliases: ['--provider'] },
      { path: 'directory', aliases: ['--dir'] }, { path: 'machineId', aliases: ['--machine'] }],
      commands: [{ path: ['mcp', 'found'], visibility: 'canonical' as const },
        { path: ['mcp', 'servers', 'detect'], visibility: 'alias' as const }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MCP_SERVER_ACTION_SPECS_V1: ReturnType<typeof createMcpServerActionSpecsV1> = lazyActionSpecArray(createMcpServerActionSpecsV1);
