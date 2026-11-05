import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { localServiceListenerGroupKey } from './listeners.js';

export const LocalServiceAddressFamilyV1Schema = lazyZodSchema(() => z.enum(['ipv4', 'ipv6', 'unknown']));
export type LocalServiceAddressFamilyV1 = z.infer<typeof LocalServiceAddressFamilyV1Schema>;

export const LocalServiceAddressV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['loopback', 'wildcard', 'lan', 'unknown']),
  host: z.string().check(z.trim(), z.minLength(1)),
  family: LocalServiceAddressFamilyV1Schema,
}));
export type LocalServiceAddressV1 = z.infer<typeof LocalServiceAddressV1Schema>;

export const LocalServiceProtocolV1Schema = lazyZodSchema(() => z.enum(['tcp']));
export type LocalServiceProtocolV1 = z.infer<typeof LocalServiceProtocolV1Schema>;

export const LocalServiceEndpointSchemeV1Schema = lazyZodSchema(() => z.enum(['http', 'https', 'unknown']));
export type LocalServiceEndpointSchemeV1 = z.infer<typeof LocalServiceEndpointSchemeV1Schema>;

export const LocalServiceEndpointProbeStateV1Schema = lazyZodSchema(() => z.enum(['ready', 'unknown']));
export type LocalServiceEndpointProbeStateV1 = z.infer<typeof LocalServiceEndpointProbeStateV1Schema>;

export const LocalServiceEndpointV1Schema = lazyZodSchema(() => z.strictObject({
  scheme: LocalServiceEndpointSchemeV1Schema,
  host: z.string().check(z.trim(), z.minLength(1)),
  port: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  probeState: LocalServiceEndpointProbeStateV1Schema,
  probedAt: z.number().check(z.int(), z.nonnegative()),
  reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
}));
export type LocalServiceEndpointV1 = z.infer<typeof LocalServiceEndpointV1Schema>;

export const LocalServiceInventoryStateV1Schema = lazyZodSchema(() => z.enum(['listening', 'stale', 'gone', 'unknown']));
export type LocalServiceInventoryStateV1 = z.infer<typeof LocalServiceInventoryStateV1Schema>;

export const LocalServiceInventorySourceV1Schema = lazyZodSchema(() => z.enum(['detected']));
export type LocalServiceInventorySourceV1 = z.infer<typeof LocalServiceInventorySourceV1Schema>;

export const LocalServiceInventoryConfidenceV1Schema = lazyZodSchema(() => z.enum(['high', 'medium', 'low']));
export type LocalServiceInventoryConfidenceV1 = z.infer<typeof LocalServiceInventoryConfidenceV1Schema>;

export const LocalServiceInventoryProcessProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  pid: z.number().check(z.int(), z.positive()),
  ppid: z.optional(z.number().check(z.int(), z.positive())),
  processStartTimeMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  lineagePids: z.optional(z.array(z.number().check(z.int(), z.positive()))),
  command: z.optional(z.string().check(z.trim(), z.minLength(1))),
  cwd: z.optional(z.string().check(z.trim(), z.minLength(1))),
  redacted: z.literal(true),
}));
export type LocalServiceInventoryProcessProvenanceV1 = z.infer<typeof LocalServiceInventoryProcessProvenanceV1Schema>;

export const LocalServiceInventoryWorkspaceProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.optional(z.string().check(z.trim(), z.minLength(1))),
  path: z.string().check(z.trim(), z.minLength(1)),
  association: z.enum(['session_owner', 'process_tree', 'cwd_containment', 'manual']),
}));
export type LocalServiceInventoryWorkspaceProvenanceV1 = z.infer<typeof LocalServiceInventoryWorkspaceProvenanceV1Schema>;

export const LocalServiceInventoryProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  process: z.optional(LocalServiceInventoryProcessProvenanceV1Schema),
  session: z.optional(z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  })),
  workspace: z.optional(LocalServiceInventoryWorkspaceProvenanceV1Schema),
  plugin: z.optional(z.strictObject({
    pluginId: z.string().check(z.trim(), z.minLength(1)),
    managedServiceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  })),
}));
export type LocalServiceInventoryProvenanceV1 = z.infer<typeof LocalServiceInventoryProvenanceV1Schema>;

export const LocalServiceInventoryClassificationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.optional(z.string().check(z.trim(), z.minLength(1))),
  displayName: z.optional(z.string().check(z.trim(), z.minLength(1))),
  confidence: z.optional(LocalServiceInventoryConfidenceV1Schema),
  lowSignal: z.optional(z.boolean()),
  signals: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
}));
export type LocalServiceInventoryClassificationV1 = z.infer<typeof LocalServiceInventoryClassificationV1Schema>;

export const LocalServiceInventoryPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  pageTitle: z.optional(z.string().check(z.trim(), z.minLength(1))),
  pageTitleSource: z.optional(z.enum(['application_name', 'og_title', 'twitter_title', 'html_title'])),
  displayName: z.optional(z.string().check(z.trim(), z.minLength(1))),
  folderLabel: z.optional(z.string().check(z.trim(), z.minLength(1))),
  addressLabel: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type LocalServiceInventoryPresentationV1 = z.infer<typeof LocalServiceInventoryPresentationV1Schema>;

export const LocalServiceInventoryLabelV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  text: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
  source: z.enum(['user', 'plugin']),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
}));
export type LocalServiceInventoryLabelV1 = z.infer<typeof LocalServiceInventoryLabelV1Schema>;

export const LocalServiceInventoryDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.string().check(z.trim(), z.minLength(1)),
  message: z.optional(z.string().check(z.trim(), z.minLength(1))),
  severity: z._default(z.optional(z.enum(['info', 'warning', 'error'])), 'info'),
}));
export type LocalServiceInventoryDiagnosticV1 = z.infer<typeof LocalServiceInventoryDiagnosticV1Schema>;

export const LocalServiceInventoryEntryV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  address: LocalServiceAddressV1Schema,
  endpoint: z.optional(LocalServiceEndpointV1Schema),
  port: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  protocol: LocalServiceProtocolV1Schema,
  detectedAt: z.number().check(z.int(), z.nonnegative()),
  lastSeenAt: z.number().check(z.int(), z.nonnegative()),
  state: LocalServiceInventoryStateV1Schema,
  source: LocalServiceInventorySourceV1Schema,
  provenance: z.optional(LocalServiceInventoryProvenanceV1Schema),
  classification: z.optional(LocalServiceInventoryClassificationV1Schema),
  presentation: z.optional(LocalServiceInventoryPresentationV1Schema),
  labels: z._default(z.array(LocalServiceInventoryLabelV1Schema), []),
  confidence: LocalServiceInventoryConfidenceV1Schema,
  processOwnershipConfidence: LocalServiceInventoryConfidenceV1Schema,
  workspaceAssociationConfidence: LocalServiceInventoryConfidenceV1Schema,
  diagnostics: z._default(z.array(LocalServiceInventoryDiagnosticV1Schema), []),
}));
export type LocalServiceInventoryEntryV1 = z.infer<typeof LocalServiceInventoryEntryV1Schema>;

export const LocalServiceInventoryRefreshStateV1Schema = lazyZodSchema(() => z.enum(['idle', 'refreshing', 'error']));
export type LocalServiceInventoryRefreshStateV1 = z.infer<typeof LocalServiceInventoryRefreshStateV1Schema>;

export const LocalServiceInventorySnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  generatedAt: z.number().check(z.int(), z.nonnegative()),
  refreshState: LocalServiceInventoryRefreshStateV1Schema,
  entries: z.array(LocalServiceInventoryEntryV1Schema),
  diagnostics: z._default(z.array(LocalServiceInventoryDiagnosticV1Schema), []),
}));
export type LocalServiceInventorySnapshotV1 = z.infer<typeof LocalServiceInventorySnapshotV1Schema>;

/** Small presentation projection carried by the existing Machine daemon-state push. */
export const LocalServiceMachineSummaryV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({
    v: z.literal(1),
    state: z.literal('ready'),
    runningCount: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({ v: z.literal(1), state: z.literal('unknown') }),
  z.strictObject({ v: z.literal(1), state: z.literal('error') }),
  z.strictObject({ v: z.literal(1), state: z.literal('disabled') }),
]));
export type LocalServiceMachineSummaryV1 = z.infer<typeof LocalServiceMachineSummaryV1Schema>;

/** Shared by the daemon publication and admitted client inventory snapshots. */
export function projectLocalServiceMachineSummaryV1(snapshot: Readonly<{
  generatedAt: number;
  refreshState: string;
  entries: readonly (Parameters<typeof localServiceListenerGroupKey>[0] & Readonly<{ state: string; classification?: unknown }>)[];
  diagnostics: readonly unknown[];
}>): LocalServiceMachineSummaryV1 {
  const codes = snapshot.diagnostics.flatMap(diagnostic => diagnostic && typeof diagnostic === 'object'
    && 'code' in diagnostic && typeof diagnostic.code === 'string' ? [diagnostic.code] : []);
  if (snapshot.refreshState === 'error') return { v: 1, state: codes.includes('local_services_inventory_probe_failed') ? 'unknown' : 'error' };
  if (codes.some(code => code.startsWith('local_services_inventory_'))) return { v: 1, state: 'disabled' };
  if (snapshot.generatedAt === 0) return { v: 1, state: 'unknown' };
  const listeners = new Set(snapshot.entries.filter(entry => entry.state === 'listening'
    && !(entry.classification && typeof entry.classification === 'object' && 'kind' in entry.classification && entry.classification.kind === 'happier'))
    .map(localServiceListenerGroupKey));
  return { v: 1, state: 'ready', runningCount: listeners.size };
}

export const LocalServiceInventoryCountResponseV1Schema = lazyZodSchema(() => z.strictObject({
  summary: LocalServiceMachineSummaryV1Schema,
}));
export type LocalServiceInventoryCountResponseV1 = z.infer<typeof LocalServiceInventoryCountResponseV1Schema>;

const DaemonLocalServiceInventoryMachineRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

export const DaemonLocalServiceInventorySnapshotRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...DaemonLocalServiceInventoryMachineRequestV1Schema.shape,
  projection: z.optional(z.literal('count')),
}));
export type DaemonLocalServiceInventorySnapshotRequestV1 = z.infer<
  typeof DaemonLocalServiceInventorySnapshotRequestV1Schema
>;

export const DaemonLocalServiceInventoryRefreshRequestV1Schema =
  DaemonLocalServiceInventoryMachineRequestV1Schema;
export type DaemonLocalServiceInventoryRefreshRequestV1 = z.infer<
  typeof DaemonLocalServiceInventoryRefreshRequestV1Schema
>;

export const DaemonLocalServiceInventorySnapshotResponseV1Schema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
  snapshot: LocalServiceInventorySnapshotV1Schema,
}));
export type DaemonLocalServiceInventorySnapshotResponseV1 = z.infer<
  typeof DaemonLocalServiceInventorySnapshotResponseV1Schema
>;

export const DaemonLocalServiceInventoryRefreshResponseV1Schema =
  DaemonLocalServiceInventorySnapshotResponseV1Schema;
export type DaemonLocalServiceInventoryRefreshResponseV1 = z.infer<
  typeof DaemonLocalServiceInventoryRefreshResponseV1Schema
>;

export const LocalServiceInventoryLabelPatchV1Schema = lazyZodSchema(() => z.strictObject({
  inventoryId: z.string().check(z.trim(), z.minLength(1)),
  label: z.strictObject({
    text: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
  }),
}));
export type LocalServiceInventoryLabelPatchV1 = z.infer<typeof LocalServiceInventoryLabelPatchV1Schema>;

export const LocalServiceInventoryUpdateEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('snapshot'),
    machineId: z.string().check(z.trim(), z.minLength(1)),
    generatedAt: z.number().check(z.int(), z.nonnegative()),
    snapshot: LocalServiceInventorySnapshotV1Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('entry_upserted'),
    machineId: z.string().check(z.trim(), z.minLength(1)),
    generatedAt: z.number().check(z.int(), z.nonnegative()),
    entry: LocalServiceInventoryEntryV1Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('entry_removed'),
    machineId: z.string().check(z.trim(), z.minLength(1)),
    generatedAt: z.number().check(z.int(), z.nonnegative()),
    id: z.string().check(z.trim(), z.minLength(1)),
  }),
]));
export type LocalServiceInventoryUpdateEventV1 = z.infer<typeof LocalServiceInventoryUpdateEventV1Schema>;

export const DaemonLocalServiceInventoryWatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  /** Hold observation demand until transport cancellation, independently of snapshot replies. */
  observationOnly: z.optional(z.literal(true)),
  /**
   * The `generatedAt` of the snapshot the caller already holds. The daemon answers immediately
   * when it has produced a newer snapshot, which closes the gap between a caller's snapshot read
   * and its first watch without needing a second identity on the wire.
   */
  sinceGeneratedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type DaemonLocalServiceInventoryWatchRequestV1 = z.infer<
  typeof DaemonLocalServiceInventoryWatchRequestV1Schema
>;

export const DaemonLocalServiceInventoryWatchResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('changed', [
  z.strictObject({
    protocolVersion: z.literal(1),
    changed: z.literal(true),
    snapshot: LocalServiceInventorySnapshotV1Schema,
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    changed: z.literal(false),
  }),
]));
export type DaemonLocalServiceInventoryWatchResponseV1 = z.infer<
  typeof DaemonLocalServiceInventoryWatchResponseV1Schema
>;
