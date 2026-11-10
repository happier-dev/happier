import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { McpDetectedProviderV1Schema } from './daemonRpcV1.js';
import type { ResolveSessionCapabilitiesV1Result, ResolvedMcpServerV1 } from '../../reach/resolveSessionCapabilitiesV1.js';
import { isReachPortableV1, type ReachContextV1 } from '../../reach/resolveReachV1.js';
import type { CapabilitySelectionReasonV1 } from '../../reach/sessionCapabilitySelectionV1.js';
import type { ReachPlaceV1 } from '../../reach/reachPlaceV1.js';
import type { McpServersSettingsV1, McpServerCatalogEntryV1 } from './settingsV1.js';
import { inferMcpServerAuthModeV1 } from './authModeV1.js';
import { McpServerCatalogEntryTransportV1Schema } from './settingsV1.js';
import { SessionMcpSelectionV1Schema, type SessionMcpSelectionV1 } from './sessionSelectionV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { SpawnCapabilitiesPreviewSuccessV1Schema } from '../../actions/specs/sessionCapabilities.js';

export type ManagedSessionMcpAvailabilityV1 = 'active' | 'available' | 'unavailable';
export type ManagedSessionMcpPortabilityV1 = 'portable' | 'machine_scoped';
export type ManagedSessionMcpReasonCodeV1 = 'active_by_default' | 'forced_included' | 'forced_excluded' | 'managed_servers_disabled' | 'binding_disabled' | 'available_portable' | 'not_portable';
export type ManagedMcpProjectionItemV1 = Readonly<{ serverId: string; name: string; title?: string; transport: McpServerCatalogEntryV1['transport'];
  bindingId: string | null; bindingTargetKind: ReachPlaceV1['t'] | null;
  selected: boolean; selectable: boolean; availability: ManagedSessionMcpAvailabilityV1; reasonCode: ManagedSessionMcpReasonCodeV1;
  portability: ManagedSessionMcpPortabilityV1; defaultSelected: boolean; effectiveConfig: McpServerCatalogEntryV1 }>;
export type ManagedMcpSelectionProjectionV1 = Readonly<{ strictMode: boolean; selection: SessionMcpSelectionV1;
  itemsByName: Readonly<Record<string, ManagedMcpProjectionItemV1>>; selectedServersByName: Readonly<Record<string, ResolvedMcpServerV1>> }>;

/** The sole translation to the released MCP-only reason vocabulary. */
function releasedReason(reason: CapabilitySelectionReasonV1, portable: boolean): ManagedSessionMcpReasonCodeV1 {
  switch (reason) {
    case 'rule_on': return 'active_by_default';
    case 'session_added': return 'forced_included';
    case 'session_removed': return 'forced_excluded';
    case 'managed_off': return 'managed_servers_disabled';
    case 'rule_off': return 'binding_disabled';
    case 'no_rule': return portable ? 'available_portable' : 'not_portable';
    case 'not_portable': case 'agent_unsupported': return 'not_portable';
  }
}

export function projectManagedMcpSelectionV1(result: ResolveSessionCapabilitiesV1Result, input: Readonly<{
  settings: McpServersSettingsV1; context: ReachContextV1; selection?: SessionMcpSelectionV1 | null;
  wireNamesByServerId?: Readonly<Record<string, string>> }>): ManagedMcpSelectionProjectionV1 {
  const selection = SessionMcpSelectionV1Schema.parse(input.selection ?? {});
  const itemsByName: Record<string, ManagedMcpProjectionItemV1> = {};
  const selectedServersByName: Record<string, ResolvedMcpServerV1> = {};
  for (const item of result.mcp.items) {
    const name = input.wireNamesByServerId?.[item.id] ?? item.name;
    const rules = input.settings.bindings.filter(rule => rule.serverId === item.id && (rule.agentId === undefined || rule.agentId === input.context.agentId));
    const portable = isReachPortableV1(rules);
    const binding = rules.find(rule => rule.id === item.decidedBy?.ruleId);
    itemsByName[name] = { serverId: item.id, name, ...(item.title ? { title: item.title } : {}), transport: item.effectiveConfig.transport,
      bindingId: item.decidedBy?.ruleId ?? null, bindingTargetKind: item.decidedBy?.target ?? null, selected: item.selected, selectable: item.selectable,
      availability: item.selected ? 'active' : item.selectable ? 'available' : 'unavailable', reasonCode: releasedReason(item.reason, portable),
      portability: portable ? 'portable' : 'machine_scoped', defaultSelected: selection.managedServersEnabled && binding?.enabled === true,
      effectiveConfig: item.effectiveConfig };
    if (item.selected) selectedServersByName[name] = { serverId: item.id, name, bindingId: item.decidedBy?.ruleId ?? null,
      enabled: true, config: item.effectiveConfig };
  }
  return { strictMode: result.mcp.strictMode, selection, itemsByName, selectedServersByName };
}

/** The sole translation to the released MCP-only scope vocabulary. */
export function projectManagedMcpPreviewEntriesV1(selection: ManagedMcpSelectionProjectionV1): ManagedMcpPreviewEntryV1[] {
  return Object.values(selection.itemsByName).map(item => ({ key: `managed:${item.serverId}`, serverId: item.serverId, name: item.name,
    ...(item.title ? { title: item.title } : {}), transport: item.transport, authMode: inferMcpServerAuthModeV1(item.effectiveConfig),
    selected: item.selected, selectable: item.selectable, availability: item.availability, sourceKind: 'managed' as const,
    scopeKind: item.bindingTargetKind === 'project' ? 'allMachines' as const : item.bindingTargetKind ?? (item.portability === 'portable' ? 'allMachines' as const : 'machine' as const),
    reasonCode: item.reasonCode, portability: item.portability, defaultSelected: item.defaultSelected,
  })).sort((left, right) => left.name.localeCompare(right.name));
}

export const McpPreviewAuthModeV1Schema = lazyZodSchema(() => z.enum(['none', 'savedSecret', 'machineEnv', 'plainText', 'unknown']));
export type McpPreviewAuthModeV1 = z.infer<typeof McpPreviewAuthModeV1Schema>;

export const McpPreviewSourceKindV1Schema = lazyZodSchema(() => z.enum(['builtIn', 'managed', 'detected']));
export type McpPreviewSourceKindV1 = z.infer<typeof McpPreviewSourceKindV1Schema>;

export const McpPreviewScopeKindV1Schema = lazyZodSchema(() => z.enum([
  'builtIn',
  'allMachines',
  'machine',
  'workspace',
  'providerUser',
  'providerProject',
]));
export type McpPreviewScopeKindV1 = z.infer<typeof McpPreviewScopeKindV1Schema>;

export const McpPreviewEntryAvailabilityV1Schema = lazyZodSchema(() => z.union([
  z.literal('active'),
  z.literal('available'),
  z.literal('unavailable'),
  z.literal('readOnly'),
]));
export type McpPreviewEntryAvailabilityV1 = z.infer<typeof McpPreviewEntryAvailabilityV1Schema>;

const ManagedAvailabilityValues = ['active', 'available', 'unavailable'] as const satisfies ReadonlyArray<ManagedSessionMcpAvailabilityV1>;
export const ManagedSessionMcpAvailabilityV1Schema = lazyZodSchema(() => {
  const schema = z.custom<ManagedSessionMcpAvailabilityV1>(
    (value) => typeof value === 'string' && ManagedAvailabilityValues.includes(value as ManagedSessionMcpAvailabilityV1),
  );
  schema._zod.processJSONSchema = (context, jsonSchema, params) =>
    context.processors.enum(z.enum(ManagedAvailabilityValues), context, jsonSchema, params);
  return schema;
});

const ManagedReasonValues = [
  'active_by_default',
  'forced_included',
  'forced_excluded',
  'managed_servers_disabled',
  'binding_disabled',
  'available_portable',
  'not_portable',
] as const satisfies ReadonlyArray<ManagedSessionMcpReasonCodeV1>;
export const ManagedSessionMcpReasonCodeV1Schema = lazyZodSchema(() => {
  const schema = z.custom<ManagedSessionMcpReasonCodeV1>(
    (value) => typeof value === 'string' && ManagedReasonValues.includes(value as ManagedSessionMcpReasonCodeV1),
  );
  schema._zod.processJSONSchema = (context, jsonSchema, params) =>
    context.processors.enum(z.enum(ManagedReasonValues), context, jsonSchema, params);
  return schema;
});

const ManagedPortabilityValues = ['portable', 'machine_scoped'] as const satisfies ReadonlyArray<ManagedSessionMcpPortabilityV1>;
export const ManagedSessionMcpPortabilityV1Schema = lazyZodSchema(() => {
  const schema = z.custom<ManagedSessionMcpPortabilityV1>(
    (value) => typeof value === 'string' && ManagedPortabilityValues.includes(value as ManagedSessionMcpPortabilityV1),
  );
  schema._zod.processJSONSchema = (context, jsonSchema, params) =>
    context.processors.enum(z.enum(ManagedPortabilityValues), context, jsonSchema, params);
  return schema;
});

const McpPreviewEntryBaseV1Schema = lazyZodSchema(() => z.object({
  key: z.string().check(z.minLength(1)),
  name: z.string().check(z.minLength(1)),
  title: z.optional(z.string().check(z.minLength(1))),
  transport: McpServerCatalogEntryTransportV1Schema,
  authMode: McpPreviewAuthModeV1Schema,
  selected: z.boolean(),
  selectable: z.boolean(),
  availability: McpPreviewEntryAvailabilityV1Schema,
  sourceKind: McpPreviewSourceKindV1Schema,
  scopeKind: McpPreviewScopeKindV1Schema,
}));

export const ManagedMcpPreviewEntryV1Schema = lazyZodSchema(() => z.extend(McpPreviewEntryBaseV1Schema, {
  serverId: z.string().check(z.minLength(1)),
  sourceKind: z.literal('managed'),
  scopeKind: z.union([z.literal('allMachines'), z.literal('machine'), z.literal('workspace')]),
  reasonCode: ManagedSessionMcpReasonCodeV1Schema,
  portability: ManagedSessionMcpPortabilityV1Schema,
  defaultSelected: z.boolean(),
}));
export type ManagedMcpPreviewEntryV1 = z.infer<typeof ManagedMcpPreviewEntryV1Schema>;

export const BuiltInMcpPreviewEntryV1Schema = lazyZodSchema(() => z.extend(McpPreviewEntryBaseV1Schema, {
  sourceKind: z.literal('builtIn'),
  scopeKind: z.literal('builtIn'),
}));
export type BuiltInMcpPreviewEntryV1 = z.infer<typeof BuiltInMcpPreviewEntryV1Schema>;

export const DetectedMcpPreviewEntryV1Schema = lazyZodSchema(() => z.extend(McpPreviewEntryBaseV1Schema, {
  sourceKind: z.literal('detected'),
  scopeKind: z.union([z.literal('providerUser'), z.literal('providerProject')]),
  provider: McpDetectedProviderV1Schema,
  enabled: z.union([z.boolean(), z.null()]),
  envKeyCount: z.number().check(z.int(), z.minimum(0)),
  headerKeyCount: z.number().check(z.int(), z.minimum(0)),
  sourcePath: z.string().check(z.minLength(1)),
}));
export type DetectedMcpPreviewEntryV1 = z.infer<typeof DetectedMcpPreviewEntryV1Schema>;

export const DaemonMcpServersPreviewRequestSchema = lazyZodSchema(() => z.looseObject({
  machineId: z.string().check(z.minLength(1)),
  directory: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
  agentId: z.string().check(z.minLength(1)),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  profileId: z.optional(z.string().check(z.minLength(1))),
  projectKey: z.optional(z.string().check(z.minLength(1))),
  capabilitySelection: z.optional(SessionCapabilitySelectionAuthoringV1Schema),
  selection: z.optional(SessionMcpSelectionV1Schema),
}));
export type DaemonMcpServersPreviewRequest = z.infer<typeof DaemonMcpServersPreviewRequestSchema>;

export const DaemonMcpServersPreviewResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    builtIn: z.array(BuiltInMcpPreviewEntryV1Schema),
    managed: z.array(ManagedMcpPreviewEntryV1Schema),
    detected: z.array(DetectedMcpPreviewEntryV1Schema),
    warnings: z.optional(z.array(z.string())),
    machinePlatform: z.optional(SpawnCapabilitiesPreviewSuccessV1Schema.shape.machinePlatform),
    mcp: z.optional(SpawnCapabilitiesPreviewSuccessV1Schema.shape.mcp),
    skills: z.optional(SpawnCapabilitiesPreviewSuccessV1Schema.shape.skills),
    applyTiming: z.optional(SpawnCapabilitiesPreviewSuccessV1Schema.shape.applyTiming),
  }),
  z.looseObject({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_request', 'internal_error']),
    error: z.string().check(z.minLength(1)),
  }),
]));
export type DaemonMcpServersPreviewResponse = z.infer<typeof DaemonMcpServersPreviewResponseSchema>;
