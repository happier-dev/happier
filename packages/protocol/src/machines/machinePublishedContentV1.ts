import { MachineServiceWatchesV1Schema } from './machineServiceWatchesV1.js';
import { z } from 'zod/mini';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { CliUpdateFactsSchema } from './cliUpdateFacts.js';
import { IrohEndpointDescriptorV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { LocalServiceMachineSummaryV1Schema } from '../local/services/inventory/v1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../sessions/metadata/windowsRemoteSessionLaunchMode.js';
import { WorkspaceSyncRuntimeEventV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { PeerLoopbackEndpointCandidateV1Schema } from './peer/mediation/loopbackEndpointV1.js';
import { MachineFinitePolicyV1Schema } from './machineFinitePolicyV1.js';
import { MachineResourcesPolicyV1Schema } from './resources/machineResourcesPolicyV1.js';
import { MachinePublishedResourceSummaryV1Schema } from './resources/machineResourceSummaryV1.js';
import { MachineSetupObservationV1Schema } from './setup/machineSetupObservationV1.js';
import { MachineSetupDesiredV1Schema } from './setup/machineSetupSourcesV1.js';
import { ActivityDecisionV1Schema } from './managed/managedIntentV1.js';
import { DevcontainerChildProjectionV1Schema, managedDevcontainerChildProjectionsEqualV1, type DevcontainerChildProjectionV1 } from './managed/devcontainerV1.js';

/** Install facts only: paths, sign-in and launch admission remain private/demanded reads. */
export const MachinePublishedAgentInventoryV1Schema = lazyZodSchema(() => z.strictObject({
  checkedAt: z.number().check(z.int(), z.nonnegative()),
  installedAgentIds: z.array(z.string().check(z.minLength(1))),
}));

/** One share-wide projection: neither owner nor recipient receives private work here. */
export const MachinePublishedMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  setup: z.optional(MachineSetupDesiredV1Schema),
  devcontainerChild: z.optional(DevcontainerChildProjectionV1Schema),
  finitePolicyV1: z.optional(MachineFinitePolicyV1Schema),
  resourcesPolicyV1: z.optional(MachineResourcesPolicyV1Schema),
  serviceWatchesV1: z.optional(MachineServiceWatchesV1Schema),
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.optional(z.string()),
  username: z.optional(z.string()),
  arch: z.optional(z.string()),
  displayName: z.optional(z.string()),
  windowsRemoteSessionLaunchMode: z.optional(WindowsRemoteSessionLaunchModeSchema),
  windowsRemoteSessionConsole: z.optional(z.enum(['hidden', 'visible'])),
  daemonTerminalSessionAttachSupported: z.optional(z.boolean()),
  daemonSessionGoalControlsSupported: z.optional(z.boolean()),
  daemonLastKnownStatus: z.optional(z.enum(['running', 'shutting-down'])),
  daemonLastKnownPid: z.optional(z.number()),
  shutdownRequestedAt: z.optional(z.number()),
  shutdownSource: z.optional(z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown'])),
  cliUpdate: z.optional(CliUpdateFactsSchema),
  agentInventory: z.optional(MachinePublishedAgentInventoryV1Schema),
}));

export const MachinePublishedTransferListenerV1Schema = lazyZodSchema(() => z.strictObject({
  enabled: z.boolean(), configured: z.boolean(), active: z.boolean(), available: z.optional(z.boolean()),
}));

export const MachinePublishedTransferRuntimeV1Schema = lazyZodSchema(() => z.strictObject({
  supported: z.strictObject({ import: z.boolean(), export: z.boolean() }),
  listenerClasses: z.strictObject({
    loopback_http: MachinePublishedTransferListenerV1Schema,
    tailscale_serve_https: MachinePublishedTransferListenerV1Schema,
  }),
  lifecycle: z.strictObject({ mode: z.literal('lazy_idle_shutdown'), version: z.literal(1) }),
}));

export const MachinePublishedWorkspaceSyncV1Schema = WorkspaceSyncRuntimeEventV1Schema;

const PeerFlowSchema = lazyZodSchema(() => z.strictObject({ active: z.boolean() }));

export const MachinePublishedDaemonStateV1Schema = lazyZodSchema(() => z.strictObject({
  setup: z.optional(MachineSetupObservationV1Schema),
  status: z.string(),
  pid: z.optional(z.number()),
  httpPort: z.optional(z.number()),
  startedAt: z.optional(z.number()),
  runtimeId: z.optional(z.string()),
  contributionRegistryProjectionRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
  cliVersion: z.optional(z.string()),
  startedWithCliVersion: z.optional(z.string()),
  publicReleaseChannel: z.optional(z.enum(['stable', 'preview', 'dev'])),
  startupSource: z.optional(z.enum(['manual', 'background-service', 'self-restart', 'installer', 'unknown'])),
  serviceManaged: z.optional(z.boolean()),
  serviceLabel: z.optional(z.string()),
  daemonPendingSessionActivationSupported: z.optional(z.boolean()),
  shutdownRequestedAt: z.optional(z.number()),
  shutdownSource: z.optional(z.string()),
  transfer: z.optional(MachinePublishedTransferRuntimeV1Schema),
  peerMediation: z.optional(z.strictObject({
    loopback: z.optional(z.strictObject({
      endpoint: z.optional(PeerLoopbackEndpointCandidateV1Schema),
      flows: z.optional(z.strictObject({
        machine_rpc: z.optional(PeerFlowSchema),
        live_stream: z.optional(PeerFlowSchema),
        tcp_tunnel: z.optional(PeerFlowSchema),
        voice_media: z.optional(PeerFlowSchema),
      })),
    })),
    iroh: z.optional(z.strictObject({ endpoint: IrohEndpointDescriptorV1Schema })),
  })),
  workspaceSync: z.optional(MachinePublishedWorkspaceSyncV1Schema),
  localServices: z.optional(LocalServiceMachineSummaryV1Schema),
  resources: z.optional(MachinePublishedResourceSummaryV1Schema),
  managedActivity: z.optional(ActivityDecisionV1Schema),
}));

/** Persistence readers discard additive/retired fields; these are not disclosure proofs. */
export const StoredMachinePublishedMetadataV1Schema = lazyZodSchema(() => z.extend(createStoredReadSchema(MachinePublishedMetadataV1Schema), {
  // The released UI treats a malformed optional update projection as absent.
  cliUpdate: z.catch(z.optional(createStoredReadSchema(CliUpdateFactsSchema)), undefined),
  agentInventory: z.catch(z.optional(createStoredReadSchema(MachinePublishedAgentInventoryV1Schema)), undefined),
}));
export const StoredMachinePublishedDaemonStateV1Schema = lazyZodSchema(() => z.extend(createStoredReadSchema(MachinePublishedDaemonStateV1Schema), {
  // Optional service presentation failures cannot erase unrelated daemon facts.
  localServices: z.catch(z.optional(createStoredReadSchema(LocalServiceMachineSummaryV1Schema)), undefined),
}));

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
