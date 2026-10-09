import { z } from 'zod';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { CliUpdateFactsSchema } from './cliUpdateFacts.js';
import { IrohEndpointDescriptorV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { LocalServiceMachineSummaryV1Schema } from '../local/services/inventory/v1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../sessions/metadata/windowsRemoteSessionLaunchMode.js';
import { WorkspaceSyncRuntimeEventV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { PeerLoopbackEndpointCandidateV1Schema } from './peer/mediation/loopbackEndpointV1.js';
import { MachineFinitePolicyV1Schema } from './machineFinitePolicyV1.js';
import { ActivityDecisionV1Schema } from './managed/managedIntentV1.js';
import { DevcontainerChildProjectionV1Schema, managedDevcontainerChildProjectionsEqualV1, type DevcontainerChildProjectionV1 } from './managed/devcontainerV1.js';

/** One share-wide projection: neither owner nor recipient receives private work here. */
export const MachinePublishedMetadataV1Schema = lazyZodSchema(() => z.object({
  devcontainerChild: z.optional(DevcontainerChildProjectionV1Schema),
  finitePolicyV1: MachineFinitePolicyV1Schema.optional(),
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string().optional(),
  username: z.string().optional(),
  arch: z.string().optional(),
  displayName: z.string().optional(),
  windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchModeSchema.optional(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
  daemonTerminalSessionAttachSupported: z.boolean().optional(),
  daemonSessionGoalControlsSupported: z.boolean().optional(),
  daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
  daemonLastKnownPid: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource: z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']).optional(),
  cliUpdate: CliUpdateFactsSchema.optional(),
}).strict());

export const MachinePublishedTransferListenerV1Schema = lazyZodSchema(() => z.object({
  enabled: z.boolean(), configured: z.boolean(), active: z.boolean(), available: z.boolean().optional(),
}).strict());

export const MachinePublishedTransferRuntimeV1Schema = lazyZodSchema(() => z.object({
  supported: z.object({ import: z.boolean(), export: z.boolean() }).strict(),
  listenerClasses: z.object({
    loopback_http: MachinePublishedTransferListenerV1Schema,
    tailscale_serve_https: MachinePublishedTransferListenerV1Schema,
  }).strict(),
  lifecycle: z.object({ mode: z.literal('lazy_idle_shutdown'), version: z.literal(1) }).strict(),
}).strict());

export const MachinePublishedWorkspaceSyncV1Schema = WorkspaceSyncRuntimeEventV1Schema;

const PeerFlowSchema = lazyZodSchema(() => z.object({ active: z.boolean() }).strict());

export const MachinePublishedDaemonStateV1Schema = lazyZodSchema(() => z.object({
  status: z.string(),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  runtimeId: z.string().optional(),
  contributionRegistryProjectionRevision: z.number().int().nonnegative().optional(),
  cliVersion: z.string().optional(),
  startedWithCliVersion: z.string().optional(),
  publicReleaseChannel: z.enum(['stable', 'preview', 'dev']).optional(),
  startupSource: z.enum(['manual', 'background-service', 'self-restart', 'installer', 'unknown']).optional(),
  serviceManaged: z.boolean().optional(),
  serviceLabel: z.string().optional(),
  daemonPendingSessionActivationSupported: z.boolean().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource: z.string().optional(),
  transfer: MachinePublishedTransferRuntimeV1Schema.optional(),
  peerMediation: z.object({
    loopback: z.object({
      endpoint: PeerLoopbackEndpointCandidateV1Schema.optional(),
      flows: z.object({
        machine_rpc: PeerFlowSchema.optional(),
        live_stream: PeerFlowSchema.optional(),
        tcp_tunnel: PeerFlowSchema.optional(),
        voice_media: PeerFlowSchema.optional(),
      }).strict().optional(),
    }).strict().optional(),
    iroh: z.object({ endpoint: IrohEndpointDescriptorV1Schema }).strict().optional(),
  }).strict().optional(),
  workspaceSync: MachinePublishedWorkspaceSyncV1Schema.optional(),
  localServices: LocalServiceMachineSummaryV1Schema.optional(),
  managedActivity: z.optional(ActivityDecisionV1Schema),
}).strict());

/** Persistence readers discard additive/retired fields; these are not disclosure proofs. */
export const StoredMachinePublishedMetadataV1Schema = lazyZodSchema(() => createStoredReadSchema(MachinePublishedMetadataV1Schema).extend({
  // The released UI treats a malformed optional update projection as absent.
  cliUpdate: createStoredReadSchema(CliUpdateFactsSchema).optional().catch(undefined),
}));
export const StoredMachinePublishedDaemonStateV1Schema = createStoredReadSchema(MachinePublishedDaemonStateV1Schema);

export type MachinePublishedMetadataV1 = z.infer<typeof MachinePublishedMetadataV1Schema>;
export type MachinePublishedDaemonStateV1 = z.infer<typeof MachinePublishedDaemonStateV1Schema>;

/** The retained-row publication, never a client-written blob claim, owns child identity. */
export function projectMachinePublishedMetadataFromRowV1(
  metadata: MachinePublishedMetadataV1 | null,
  devcontainerChild: DevcontainerChildProjectionV1 | null | undefined,
): MachinePublishedMetadataV1 | null {
  if (metadata === null) return null;
  if (devcontainerChild === undefined && metadata.devcontainerChild !== undefined) {
    throw Object.assign(new Error('Machine child authority is unavailable'), { code: 'machine_unavailable' });
  }
  if (devcontainerChild != null) devcontainerChild = DevcontainerChildProjectionV1Schema.parse(devcontainerChild);
  if (managedDevcontainerChildProjectionsEqualV1(metadata.devcontainerChild, devcontainerChild ?? undefined)) return metadata;
  const { devcontainerChild: _claimedChild, ...fields } = metadata;
  return devcontainerChild ? { ...fields, devcontainerChild } : fields;
}

function hasCanonicalPublishedShape(value: unknown, projection: unknown): boolean {
  if (value === projection) return true;
  if (Array.isArray(value) || Array.isArray(projection)) {
    return Array.isArray(value) && Array.isArray(projection)
      && value.length === projection.length
      && value.every((entry, index) => hasCanonicalPublishedShape(entry, projection[index]));
  }
  if (!value || !projection || typeof value !== 'object' || typeof projection !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  const projectedRecord = projection as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  return keys.length === Object.keys(projectedRecord).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(projectedRecord, key)
      && hasCanonicalPublishedShape(record[key], projectedRecord[key]));
}

/** Call only with the entire opened blobs, before any tolerant read projection. */
export function isMachinePublishedContentSafeV1(input: Readonly<{
  metadata: unknown;
  daemonState: unknown | null;
}>): boolean {
  const metadata = MachinePublishedMetadataV1Schema.safeParse(input.metadata);
  if (!metadata.success || !hasCanonicalPublishedShape(input.metadata, metadata.data)) return false;
  if (input.daemonState === null) return true;
  const daemonState = MachinePublishedDaemonStateV1Schema.safeParse(input.daemonState);
  // Existing additive presentation children (CLI update facts) may drop unknown
  // fields on parse. Safety requires the actual blob to already be canonical.
  return daemonState.success && hasCanonicalPublishedShape(input.daemonState, daemonState.data);
}

/** Write admission rejects unknown nested bags rather than silently projecting them. */
export function parseMachinePublishedMetadataV1(value: unknown): MachinePublishedMetadataV1 {
  const parsed = MachinePublishedMetadataV1Schema.safeParse(value);
  if (!parsed.success || !hasCanonicalPublishedShape(value, parsed.data)) {
    throw Object.assign(new Error('Unsupported Machine metadata publication'), { retryable: false });
  }
  return parsed.data;
}

export function parseMachinePublishedDaemonStateV1(value: unknown): MachinePublishedDaemonStateV1 {
  const parsed = MachinePublishedDaemonStateV1Schema.safeParse(value);
  if (!parsed.success || !hasCanonicalPublishedShape(value, parsed.data)) {
    throw Object.assign(new Error('Unsupported Machine daemon-state publication'), { retryable: false });
  }
  return parsed.data;
}
