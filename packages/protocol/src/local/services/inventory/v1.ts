import { z } from 'zod';

export const LocalServiceAddressFamilyV1Schema = z.enum(['ipv4', 'ipv6', 'unknown']);
export type LocalServiceAddressFamilyV1 = z.infer<typeof LocalServiceAddressFamilyV1Schema>;

export const LocalServiceAddressV1Schema = z.object({
  kind: z.enum(['loopback', 'wildcard', 'lan', 'unknown']),
  host: z.string().trim().min(1),
  family: LocalServiceAddressFamilyV1Schema,
}).strict();
export type LocalServiceAddressV1 = z.infer<typeof LocalServiceAddressV1Schema>;

export const LocalServiceProtocolV1Schema = z.enum(['tcp']);
export type LocalServiceProtocolV1 = z.infer<typeof LocalServiceProtocolV1Schema>;

export const LocalServiceEndpointSchemeV1Schema = z.enum(['http', 'https', 'unknown']);
export type LocalServiceEndpointSchemeV1 = z.infer<typeof LocalServiceEndpointSchemeV1Schema>;

export const LocalServiceEndpointProbeStateV1Schema = z.enum(['ready', 'unknown']);
export type LocalServiceEndpointProbeStateV1 = z.infer<typeof LocalServiceEndpointProbeStateV1Schema>;

export const LocalServiceEndpointV1Schema = z.object({
  scheme: LocalServiceEndpointSchemeV1Schema,
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535),
  probeState: LocalServiceEndpointProbeStateV1Schema,
  probedAt: z.number().int().nonnegative(),
  reasonCode: z.string().trim().min(1).max(256).optional(),
}).strict();
export type LocalServiceEndpointV1 = z.infer<typeof LocalServiceEndpointV1Schema>;

export const LocalServiceInventoryStateV1Schema = z.enum(['listening', 'stale', 'gone', 'unknown']);
export type LocalServiceInventoryStateV1 = z.infer<typeof LocalServiceInventoryStateV1Schema>;

export const LocalServiceInventorySourceV1Schema = z.enum(['detected']);
export type LocalServiceInventorySourceV1 = z.infer<typeof LocalServiceInventorySourceV1Schema>;

export const LocalServiceInventoryConfidenceV1Schema = z.enum(['high', 'medium', 'low']);
export type LocalServiceInventoryConfidenceV1 = z.infer<typeof LocalServiceInventoryConfidenceV1Schema>;

export const LocalServiceInventoryProcessProvenanceV1Schema = z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().positive().optional(),
  processStartTimeMs: z.number().int().nonnegative().optional(),
  lineagePids: z.array(z.number().int().positive()).optional(),
  command: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  redacted: z.literal(true),
}).strict();
export type LocalServiceInventoryProcessProvenanceV1 = z.infer<typeof LocalServiceInventoryProcessProvenanceV1Schema>;

export const LocalServiceInventoryWorkspaceProvenanceV1Schema = z.object({
  id: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1),
  association: z.enum(['session_owner', 'process_tree', 'cwd_containment', 'manual']),
}).strict();
export type LocalServiceInventoryWorkspaceProvenanceV1 = z.infer<typeof LocalServiceInventoryWorkspaceProvenanceV1Schema>;

export const LocalServiceInventoryProvenanceV1Schema = z.object({
  process: LocalServiceInventoryProcessProvenanceV1Schema.optional(),
  session: z.object({
    id: z.string().trim().min(1),
    turnId: z.string().trim().min(1).optional(),
  }).strict().optional(),
  workspace: LocalServiceInventoryWorkspaceProvenanceV1Schema.optional(),
  plugin: z.object({
    pluginId: z.string().trim().min(1),
    managedServiceId: z.string().trim().min(1).optional(),
  }).strict().optional(),
}).strict();
export type LocalServiceInventoryProvenanceV1 = z.infer<typeof LocalServiceInventoryProvenanceV1Schema>;

export const LocalServiceInventoryClassificationV1Schema = z.object({
  kind: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  confidence: LocalServiceInventoryConfidenceV1Schema.optional(),
  lowSignal: z.boolean().optional(),
  signals: z.array(z.string().trim().min(1)).optional().default([]),
}).strict();
export type LocalServiceInventoryClassificationV1 = z.infer<typeof LocalServiceInventoryClassificationV1Schema>;

export const LocalServiceInventoryPresentationV1Schema = z.object({
  pageTitle: z.string().trim().min(1).optional(),
  pageTitleSource: z.enum(['application_name', 'og_title', 'twitter_title', 'html_title']).optional(),
  displayName: z.string().trim().min(1).optional(),
  folderLabel: z.string().trim().min(1).optional(),
  addressLabel: z.string().trim().min(1).optional(),
}).strict();
export type LocalServiceInventoryPresentationV1 = z.infer<typeof LocalServiceInventoryPresentationV1Schema>;

export const LocalServiceInventoryLabelV1Schema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1).max(120),
  source: z.enum(['user', 'plugin']),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type LocalServiceInventoryLabelV1 = z.infer<typeof LocalServiceInventoryLabelV1Schema>;

export const LocalServiceInventoryDiagnosticV1Schema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1).optional(),
  severity: z.enum(['info', 'warning', 'error']).optional().default('info'),
}).strict();
export type LocalServiceInventoryDiagnosticV1 = z.infer<typeof LocalServiceInventoryDiagnosticV1Schema>;

export const LocalServiceInventoryEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  machineId: z.string().trim().min(1),
  address: LocalServiceAddressV1Schema,
  endpoint: LocalServiceEndpointV1Schema.optional(),
  port: z.number().int().min(1).max(65_535),
  protocol: LocalServiceProtocolV1Schema,
  detectedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  state: LocalServiceInventoryStateV1Schema,
  source: LocalServiceInventorySourceV1Schema,
  provenance: LocalServiceInventoryProvenanceV1Schema.optional(),
  classification: LocalServiceInventoryClassificationV1Schema.optional(),
  presentation: LocalServiceInventoryPresentationV1Schema.optional(),
  labels: z.array(LocalServiceInventoryLabelV1Schema).default([]),
  confidence: LocalServiceInventoryConfidenceV1Schema,
  processOwnershipConfidence: LocalServiceInventoryConfidenceV1Schema,
  workspaceAssociationConfidence: LocalServiceInventoryConfidenceV1Schema,
  diagnostics: z.array(LocalServiceInventoryDiagnosticV1Schema).default([]),
}).strict();
export type LocalServiceInventoryEntryV1 = z.infer<typeof LocalServiceInventoryEntryV1Schema>;

export const LocalServiceInventoryRefreshStateV1Schema = z.enum(['idle', 'refreshing', 'error']);
export type LocalServiceInventoryRefreshStateV1 = z.infer<typeof LocalServiceInventoryRefreshStateV1Schema>;

export const LocalServiceInventorySnapshotV1Schema = z.object({
  v: z.literal(1),
  machineId: z.string().trim().min(1),
  generatedAt: z.number().int().nonnegative(),
  refreshState: LocalServiceInventoryRefreshStateV1Schema,
  entries: z.array(LocalServiceInventoryEntryV1Schema),
  diagnostics: z.array(LocalServiceInventoryDiagnosticV1Schema).default([]),
}).strict();
export type LocalServiceInventorySnapshotV1 = z.infer<typeof LocalServiceInventorySnapshotV1Schema>;

const DaemonLocalServiceInventoryMachineRequestV1Schema = z.object({
  machineId: z.string().trim().min(1).max(256),
}).strict();

export const DaemonLocalServiceInventorySnapshotRequestV1Schema =
  DaemonLocalServiceInventoryMachineRequestV1Schema;
export type DaemonLocalServiceInventorySnapshotRequestV1 = z.infer<
  typeof DaemonLocalServiceInventorySnapshotRequestV1Schema
>;

export const DaemonLocalServiceInventoryRefreshRequestV1Schema =
  DaemonLocalServiceInventoryMachineRequestV1Schema;
export type DaemonLocalServiceInventoryRefreshRequestV1 = z.infer<
  typeof DaemonLocalServiceInventoryRefreshRequestV1Schema
>;

export const DaemonLocalServiceInventorySnapshotResponseV1Schema = z.object({
  protocolVersion: z.literal(1),
  snapshot: LocalServiceInventorySnapshotV1Schema,
}).strict();
export type DaemonLocalServiceInventorySnapshotResponseV1 = z.infer<
  typeof DaemonLocalServiceInventorySnapshotResponseV1Schema
>;

export const DaemonLocalServiceInventoryRefreshResponseV1Schema =
  DaemonLocalServiceInventorySnapshotResponseV1Schema;
export type DaemonLocalServiceInventoryRefreshResponseV1 = z.infer<
  typeof DaemonLocalServiceInventoryRefreshResponseV1Schema
>;

export const LocalServiceInventoryLabelPatchV1Schema = z.object({
  inventoryId: z.string().trim().min(1),
  label: z.object({
    text: z.string().trim().min(1).max(120),
  }).strict(),
}).strict();
export type LocalServiceInventoryLabelPatchV1 = z.infer<typeof LocalServiceInventoryLabelPatchV1Schema>;

export const LocalServiceInventoryUpdateEventV1Schema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('snapshot'),
    machineId: z.string().trim().min(1),
    generatedAt: z.number().int().nonnegative(),
    snapshot: LocalServiceInventorySnapshotV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('entry_upserted'),
    machineId: z.string().trim().min(1),
    generatedAt: z.number().int().nonnegative(),
    entry: LocalServiceInventoryEntryV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('entry_removed'),
    machineId: z.string().trim().min(1),
    generatedAt: z.number().int().nonnegative(),
    id: z.string().trim().min(1),
  }).strict(),
]);
export type LocalServiceInventoryUpdateEventV1 = z.infer<typeof LocalServiceInventoryUpdateEventV1Schema>;

/**
 * How long the daemon holds an inventory watch open before answering "nothing changed".
 *
 * The watch is the push half of local-service freshness: the client keeps exactly one watch
 * outstanding while a surface is mounted and re-arms on each answer, so there is no client-side
 * poll timer anywhere. The window is the daemon's, not the caller's — a client derives its RPC
 * timeout from this constant rather than restating a number, and the server forwards any
 * caller-requested timeout up to its own maximum, so no server change is needed to hold it open.
 */
export const LOCAL_SERVICE_INVENTORY_WATCH_WINDOW_MS = 25_000;

export const DaemonLocalServiceInventoryWatchRequestV1Schema = z.object({
  machineId: z.string().trim().min(1).max(256),
  /**
   * The `generatedAt` of the snapshot the caller already holds. The daemon answers immediately
   * when it has produced a newer snapshot, which closes the gap between a caller's snapshot read
   * and its first watch without needing a second identity on the wire.
   */
  sinceGeneratedAt: z.number().int().nonnegative().optional(),
}).strict();
export type DaemonLocalServiceInventoryWatchRequestV1 = z.infer<
  typeof DaemonLocalServiceInventoryWatchRequestV1Schema
>;

export const DaemonLocalServiceInventoryWatchResponseV1Schema = z.discriminatedUnion('changed', [
  z.object({
    protocolVersion: z.literal(1),
    changed: z.literal(true),
    snapshot: LocalServiceInventorySnapshotV1Schema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
    changed: z.literal(false),
  }).strict(),
]);
export type DaemonLocalServiceInventoryWatchResponseV1 = z.infer<
  typeof DaemonLocalServiceInventoryWatchResponseV1Schema
>;
