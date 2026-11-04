import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { McpRemoteUrlV1Schema } from '../remoteUrlV1.js';
import { ReachPlaceV1Schema } from '../../reach/reachPlaceV1.js';
import { ReachRuleV1Schema } from '../../reach/reachRuleV1.js';
import { reachRuleKeyV1 } from '../../reach/reachRulesChangeV1.js';
import { ValueRefV1Schema } from '../../valueRefs/valueRefV1.js';
import { RegistryProvenanceV1Schema } from '../../registries/registryItemsV1.js';
import { RegistryUpstreamV1Schema } from '../../registries/registryUpstreamV1.js';
import type { PluginMcpServerContributionV1 } from '../../plugins/contributions/mcp.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '../../plugins/actions/protocolComposableSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
export { ReachPlaceV1Schema } from '../../reach/reachPlaceV1.js';
export type { ReachPlaceV1 } from '../../reach/reachPlaceV1.js';

const SERVER_NAME_REGEX = /^[a-z0-9_-]+$/;
const RESERVED_SERVER_NAMES = new Set(['happier', '__proto__', 'prototype', 'constructor']);

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_KEY_REGEX = /^[A-Za-z0-9-]+$/;

const McpEnvVarKeyV1Schema = lazyZodSchema(() => z.string().check(z.regex(ENV_KEY_REGEX, 'Invalid environment variable name')));
const McpHeaderKeyV1Schema = lazyZodSchema(() => z.string().check(z.regex(HEADER_KEY_REGEX, 'Invalid header name')));

export const McpServerCatalogEntryTransportV1Schema = lazyZodSchema(() => z.enum(['stdio', 'http', 'sse']));
export type McpServerCatalogEntryTransportV1 = z.infer<typeof McpServerCatalogEntryTransportV1Schema>;

const McpValueRefOrNullV1Schema = lazyZodSchema(() => z.union([ValueRefV1Schema, z.null()]));
const McpWorkingFolderPathV1Schema = lazyZodSchema(() => z.strictObject({ t: z.literal('path'), path: z.string().check(z.minLength(1)) }));
const McpWorkingFolderV1Schema = lazyZodSchema(() => z.union([z.strictObject({ t: z.literal('session') }), McpWorkingFolderPathV1Schema]));
const McpToolSettingV1Definition = defineProtocolUnion([
  defineProtocolLiteral('off'), defineProtocolLiteral('ask'), defineProtocolLiteral('allow'),
]);
export const McpToolSettingV1Schema = asProtocolZod(McpToolSettingV1Definition);
export type McpToolSettingV1 = z.infer<typeof McpToolSettingV1Schema>;
// MCP tool names are opaque external keys, including valid names such as
// '__proto__'. The composable dictionary preserves and validates every own key.
export const McpToolSettingsV1Schema: z.ZodMiniType<Readonly<Record<string, McpToolSettingV1>>, Readonly<Record<string, McpToolSettingV1>>> = asProtocolZod(defineProtocolObject({}, {
  policy: 'additive-open/preserve', additionalProperties: McpToolSettingV1Definition,
}));
const McpToolSettingsPatchV1Schema: z.ZodMiniType<Readonly<Record<string, McpToolSettingV1 | 'inherit'>>, Readonly<Record<string, McpToolSettingV1 | 'inherit'>>> = asProtocolZod(defineProtocolObject({}, {
  policy: 'additive-open/preserve', additionalProperties: defineProtocolUnion([McpToolSettingV1Definition, defineProtocolLiteral('inherit')]),
}));
export const McpServerToolPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  default: z.enum(['ask', 'allow_read_only', 'allow_all']), overrides: McpToolSettingsV1Schema,
}));
export type McpServerToolPolicyV1 = z.infer<typeof McpServerToolPolicyV1Schema>;
export const McpServerToolSettingsPatchV1Schema = lazyZodSchema(() => z.strictObject({
  default: z.optional(McpServerToolPolicyV1Schema.shape.default),
  tools: zMini.optional(McpToolSettingsPatchV1Schema),
}));
export type McpServerToolSettingsPatchV1 = z.infer<typeof McpServerToolSettingsPatchV1Schema>;
export const McpToolAnnotationsV1Schema = lazyZodSchema(() => z.strictObject({
  readOnlyHint: z.optional(z.boolean()), destructiveHint: z.optional(z.boolean()),
  idempotentHint: z.optional(z.boolean()), openWorldHint: z.optional(z.boolean()),
}));
export type McpToolAnnotationsV1 = z.infer<typeof McpToolAnnotationsV1Schema>;
export const McpServerToolsSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  checkedAt: z.number(), machineId: z.string().check(z.minLength(1)), protocolVersion: z.optional(z.string()),
  serverInfo: z.optional(z.strictObject({ name: z.string(), version: z.optional(z.string()) })),
  instructions: z.optional(z.string()), tools: z.array(z.strictObject({
    name: z.string(), title: z.optional(z.string()), description: z.optional(z.string()),
    annotations: z.optional(McpToolAnnotationsV1Schema), tokens: z.number().check(z.nonnegative()),
  })),
}));
export type McpServerToolsSnapshotV1 = z.infer<typeof McpServerToolsSnapshotV1Schema>;
export const McpServerPluginSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  tools: z.optional(McpServerToolPolicyV1Schema), toolsSnapshot: z.optional(McpServerToolsSnapshotV1Schema),
}));
export const McpServerPluginSettingsMapV1Schema = lazyZodSchema(() => z.record(
  z.string().check(z.refine(isMcpPluginItemIdV1, 'Invalid plugin MCP item id')), McpServerPluginSettingsV1Schema,
));
export const McpServerConfigOverrideFieldsV1Schema = lazyZodSchema(() => z.strictObject({
  stdio: z.optional(z.strictObject({ command: z.optional(z.string().check(z.minLength(1))), args: z.optional(z.array(z.string())),
    cwd: z.optional(McpWorkingFolderV1Schema) })),
  remote: z.optional(z.strictObject({ url: zMini.optional(McpRemoteUrlV1Schema), headersPatch: z.optional(z.record(McpHeaderKeyV1Schema, McpValueRefOrNullV1Schema)) })),
  envPatch: z.optional(z.record(McpEnvVarKeyV1Schema, McpValueRefOrNullV1Schema)),
}));
export type McpServerConfigOverrideFieldsV1 = z.infer<typeof McpServerConfigOverrideFieldsV1Schema>;
export const McpServerConfigOverrideV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerConfigOverrideFieldsV1Schema, {
  target: z.union([ReachPlaceV1Schema._zod.def.options[1], ReachPlaceV1Schema._zod.def.options[3]]),
})));
export type McpServerConfigOverrideV1 = z.infer<typeof McpServerConfigOverrideV1Schema>;

export const McpServerCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
    id: z.string().check(z.minLength(1)),
    name: z
      .string().check(z.minLength(1), z.regex(SERVER_NAME_REGEX, 'Invalid MCP server name'), z.refine((value) => !RESERVED_SERVER_NAMES.has(value), 'Reserved MCP server name')),
    title: z.optional(z.string().check(z.minLength(1))),
    description: z.optional(z.string().check(z.minLength(1))),
    transport: McpServerCatalogEntryTransportV1Schema,
    stdio: z.optional(z.strictObject({
        command: z.string().check(z.minLength(1)),
        args: z.array(z.string()),
        cwd: z.optional(McpWorkingFolderV1Schema),
      })),
    remote: z.optional(z.strictObject({
        url: McpRemoteUrlV1Schema,
        urlTemplate: zMini.optional(ValueRefV1Schema._zod.def.options[2]),
        headers: z.record(McpHeaderKeyV1Schema, ValueRefV1Schema),
        auth: z.optional(z.strictObject({ kind: z.literal('oauth') })),
      })),
    env: z.record(McpEnvVarKeyV1Schema, ValueRefV1Schema),
    configOverrides: z.optional(z.array(McpServerConfigOverrideV1Schema)),
    tools: z.optional(McpServerToolPolicyV1Schema),
    toolsSnapshot: z.optional(McpServerToolsSnapshotV1Schema),
    origin: z.optional(z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('registry'), provenance: RegistryProvenanceV1Schema,
        upstream: zMini.optional(RegistryUpstreamV1Schema),
        upstreamObservedAt: z.optional(z.number().check(z.int(), z.gte(0))) }),
      z.strictObject({ kind: z.literal('machine'), machineId: z.string().check(z.minLength(1)), agentId: z.string().check(z.minLength(1)) }),
    ])),
    createdAt: z.number(),
    updatedAt: z.number(),
  }).check(z.superRefine((value, ctx) => {
    if (value.transport === 'stdio') {
      if (!value.stdio) {
        ctx.addIssue({ code: 'custom', message: 'Missing stdio config', path: ['stdio'] });
      }
      if (value.remote) {
        ctx.addIssue({ code: 'custom', message: 'remote is not allowed for stdio servers', path: ['remote'] });
      }
      return;
    }
    if (value.stdio) {
      ctx.addIssue({ code: 'custom', message: 'stdio is not allowed for remote servers', path: ['stdio'] });
    }
    if (!value.remote) {
      ctx.addIssue({ code: 'custom', message: 'Missing remote config', path: ['remote'] });
    }
  })));

export type McpServerCatalogEntryV1 = z.infer<typeof McpServerCatalogEntryV1Schema>;

export const McpServerRuleV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(ReachRuleV1Schema, {
  serverId: z.string().check(z.minLength(1)),
})));
export type McpServerRuleV1 = z.infer<typeof McpServerRuleV1Schema>;
export function mcpPluginItemIdV1(input: Readonly<{ pluginId: string; localId: string }>): string { return `plugin:${input.pluginId}/${input.localId}`; }
export function parseMcpPluginItemIdV1(value: string): Readonly<{ pluginId: string; localId: string }> | null {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(value);
  if (!match) return null;
  const ref = PluginContributionIdentityV1Schema.safeParse({ pluginId: match[1], localId: match[2] });
  return ref.success ? ref.data : null;
}
export function isMcpPluginItemIdV1(value: string): boolean { return parseMcpPluginItemIdV1(value) !== null; }
export type McpPluginItemV1 = Readonly<{ itemId: string; name: string; title?: string; config: McpServerCatalogEntryV1; rules: readonly McpServerRuleV1[] }>;
export const McpPluginItemMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.refine(isMcpPluginItemIdV1)), name: z.string().check(z.minLength(1)), title: z.optional(z.string()),
  description: z.optional(z.string()), transport: McpServerCatalogEntryTransportV1Schema,
  source: z.strictObject({ kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)), pluginName: z.string().check(z.minLength(1)) }),
}));
export type McpPluginItemMetadataV1 = z.infer<typeof McpPluginItemMetadataV1Schema>;
/** Declaration-only projection shared by client lists and runtime admission. */
export function projectMcpPluginItemMetadataV1(input: Readonly<{ pluginId: string; pluginName: string; server: PluginMcpServerContributionV1 }>): McpPluginItemMetadataV1 {
  const { server } = input;
  const localName = server.id.replaceAll('/', '_');
  const name = RESERVED_SERVER_NAMES.has(localName) ? `plugin_${localName}` : localName;
  return McpPluginItemMetadataV1Schema.parse({ id: mcpPluginItemIdV1({ pluginId: input.pluginId, localId: server.id }),
    name, title: typeof server.title === 'string' ? server.title : server.title.fallback,
    ...(server.description ? { description: typeof server.description === 'string' ? server.description : server.description.fallback } : {}),
    transport: server.kind === 'static' && server.transport.kind === 'stdio' ? 'stdio' : 'http',
    source: { kind: 'plugin', pluginId: input.pluginId, pluginName: input.pluginName } });
}

export function refineMcpServerCatalogV1(value: Readonly<{
  servers: readonly McpServerCatalogEntryV1[]; bindings: readonly McpServerRuleV1[];
}>, ctx: z.core.$RefinementCtx): void {
  const serverIds = new Set<string>();
  const serverNames = new Set<string>();
  for (const [i, server] of value.servers.entries()) {
    if (serverIds.has(server.id)) ctx.addIssue({ code: 'custom', message: `Duplicate server id: ${server.id}`, path: ['servers', i, 'id'] });
    if (serverNames.has(server.name)) ctx.addIssue({ code: 'custom', message: `Duplicate server name: ${server.name}`, path: ['servers', i, 'name'] });
    serverIds.add(server.id); serverNames.add(server.name);
  }
  const bindingIds = new Set<string>();
  const ruleKeys = new Set<string>();
  for (const [i, binding] of value.bindings.entries()) {
    if (bindingIds.has(binding.id)) ctx.addIssue({ code: 'custom', message: `Duplicate binding id: ${binding.id}`, path: ['bindings', i, 'id'] });
    if (!serverIds.has(binding.serverId) && !isMcpPluginItemIdV1(binding.serverId)) ctx.addIssue({ code: 'custom', message: `Server not found: ${binding.serverId}`, path: ['bindings', i, 'serverId'] });
    const key = JSON.stringify([binding.serverId, reachRuleKeyV1(binding)]);
    if (ruleKeys.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate reach rule', path: ['bindings', i] });
    ruleKeys.add(key);
    bindingIds.add(binding.id);
  }
}

export const McpServersSettingsV1Schema = lazyZodSchema(() => (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    }), z
      .object({
        v: z._default(z.literal(1), 1),
        strictMode: z._default(z.boolean(), false),
        servers: z._default(z.array(McpServerCatalogEntryV1Schema), []),
        bindings: z._default(z.array(McpServerRuleV1Schema), []),
        pluginServers: z.optional(McpServerPluginSettingsMapV1Schema),
      }).check(z.superRefine(refineMcpServerCatalogV1))));

export type McpServersSettingsV1 = z.infer<typeof McpServersSettingsV1Schema>;
