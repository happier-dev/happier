import { z } from 'zod';

import { McpDetectedProviderV1Schema } from './daemonRpcV1.js';
import type {
  ManagedSessionMcpAvailabilityV1,
  ManagedSessionMcpPortabilityV1,
  ManagedSessionMcpReasonCodeV1,
} from './resolveManagedSessionMcpSelectionV1.js';
import { McpServerCatalogEntryTransportV1Schema } from './settingsV1.js';
import { SessionMcpSelectionV1Schema } from './sessionSelectionV1.js';

export const McpPreviewAuthModeV1Schema = z.enum(['none', 'savedSecret', 'machineEnv', 'plainText', 'unknown']);
export type McpPreviewAuthModeV1 = z.infer<typeof McpPreviewAuthModeV1Schema>;

export const McpPreviewSourceKindV1Schema = z.enum(['builtIn', 'managed', 'detected']);
export type McpPreviewSourceKindV1 = z.infer<typeof McpPreviewSourceKindV1Schema>;

export const McpPreviewScopeKindV1Schema = z.enum([
  'builtIn',
  'allMachines',
  'machine',
  'workspace',
  'providerUser',
  'providerProject',
]);
export type McpPreviewScopeKindV1 = z.infer<typeof McpPreviewScopeKindV1Schema>;

export const McpPreviewEntryAvailabilityV1Schema = z.union([
  z.literal('active'),
  z.literal('available'),
  z.literal('unavailable'),
  z.literal('readOnly'),
]);
export type McpPreviewEntryAvailabilityV1 = z.infer<typeof McpPreviewEntryAvailabilityV1Schema>;

const ManagedAvailabilityValues = ['active', 'available', 'unavailable'] as const satisfies ReadonlyArray<ManagedSessionMcpAvailabilityV1>;
export const ManagedSessionMcpAvailabilityV1Schema = z.custom<ManagedSessionMcpAvailabilityV1>(
  (value) => typeof value === 'string' && ManagedAvailabilityValues.includes(value as ManagedSessionMcpAvailabilityV1),
);

const ManagedReasonValues = [
  'active_by_default',
  'forced_included',
  'forced_excluded',
  'managed_servers_disabled',
  'binding_disabled',
  'available_portable',
  'not_portable',
] as const satisfies ReadonlyArray<ManagedSessionMcpReasonCodeV1>;
export const ManagedSessionMcpReasonCodeV1Schema = z.custom<ManagedSessionMcpReasonCodeV1>(
  (value) => typeof value === 'string' && ManagedReasonValues.includes(value as ManagedSessionMcpReasonCodeV1),
);

const ManagedPortabilityValues = ['portable', 'machine_scoped'] as const satisfies ReadonlyArray<ManagedSessionMcpPortabilityV1>;
export const ManagedSessionMcpPortabilityV1Schema = z.custom<ManagedSessionMcpPortabilityV1>(
  (value) => typeof value === 'string' && ManagedPortabilityValues.includes(value as ManagedSessionMcpPortabilityV1),
);

const McpPreviewEntryBaseV1Schema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  transport: McpServerCatalogEntryTransportV1Schema,
  authMode: McpPreviewAuthModeV1Schema,
  selected: z.boolean(),
  selectable: z.boolean(),
  availability: McpPreviewEntryAvailabilityV1Schema,
  sourceKind: McpPreviewSourceKindV1Schema,
  scopeKind: McpPreviewScopeKindV1Schema,
});

export const ManagedMcpPreviewEntryV1Schema = McpPreviewEntryBaseV1Schema.extend({
  serverId: z.string().min(1),
  sourceKind: z.literal('managed'),
  scopeKind: z.union([z.literal('allMachines'), z.literal('machine'), z.literal('workspace')]),
  reasonCode: ManagedSessionMcpReasonCodeV1Schema,
  portability: ManagedSessionMcpPortabilityV1Schema,
  defaultSelected: z.boolean(),
});
export type ManagedMcpPreviewEntryV1 = z.infer<typeof ManagedMcpPreviewEntryV1Schema>;

export const BuiltInMcpPreviewEntryV1Schema = McpPreviewEntryBaseV1Schema.extend({
  sourceKind: z.literal('builtIn'),
  scopeKind: z.literal('builtIn'),
});
export type BuiltInMcpPreviewEntryV1 = z.infer<typeof BuiltInMcpPreviewEntryV1Schema>;

export const DetectedMcpPreviewEntryV1Schema = McpPreviewEntryBaseV1Schema.extend({
  sourceKind: z.literal('detected'),
  scopeKind: z.union([z.literal('providerUser'), z.literal('providerProject')]),
  provider: McpDetectedProviderV1Schema,
  enabled: z.union([z.boolean(), z.null()]),
  envKeyCount: z.number().int().min(0),
  headerKeyCount: z.number().int().min(0),
  sourcePath: z.string().min(1),
});
export type DetectedMcpPreviewEntryV1 = z.infer<typeof DetectedMcpPreviewEntryV1Schema>;

export const DaemonMcpServersPreviewRequestSchema = z.object({
  machineId: z.string().min(1),
  directory: z.string().min(1).max(10_000),
  agentId: z.string().min(1),
  selection: SessionMcpSelectionV1Schema.optional(),
}).passthrough();
export type DaemonMcpServersPreviewRequest = z.infer<typeof DaemonMcpServersPreviewRequestSchema>;

export const DaemonMcpServersPreviewResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    builtIn: z.array(BuiltInMcpPreviewEntryV1Schema),
    managed: z.array(ManagedMcpPreviewEntryV1Schema),
    detected: z.array(DetectedMcpPreviewEntryV1Schema),
    warnings: z.array(z.string()).optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_request', 'internal_error']),
    error: z.string().min(1),
  }).passthrough(),
]);
export type DaemonMcpServersPreviewResponse = z.infer<typeof DaemonMcpServersPreviewResponseSchema>;
