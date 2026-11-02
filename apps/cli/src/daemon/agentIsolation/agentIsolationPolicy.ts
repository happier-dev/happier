import { MachineAgentIsolationStatusV1Schema, readMachineAgentIsolationPolicyV1, type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import type { MachineMetadataFieldReadV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';

export type AgentIsolationSnapshot = Readonly<{ enabled: boolean; memberProvisioning?: 'linuxUsersV1'; status: MachineAgentIsolationStatusV1 }>;

/** Held daemon facts only. Retained facts from another daemon never admit an isolated launch. */
export function readAgentIsolationSnapshot(input: Readonly<{
  metadata: MachineMetadataFieldReadV1;
  daemonState: unknown;
  runtimeId: string | undefined;
  platform: NodeJS.Platform;
  publicationFailed?: boolean;
}>): AgentIsolationSnapshot {
  if (input.metadata.status !== 'ready') return { enabled: true, status: { kind: 'unavailable', code: 'metadata_unavailable' } };
  const policy = readMachineAgentIsolationPolicyV1(input.metadata.metadata);
  if (policy.status !== 'ready') return { enabled: true, status: { kind: 'unavailable', code: 'metadata_unavailable' } };
  const unavailable: MachineAgentIsolationStatusV1 = { kind: 'unavailable',
    code: input.platform === 'win32' ? 'unsupported_platform' : 'provisioning_unavailable' };
  const desired = { enabled: policy.policy.enabled,
    ...(policy.policy.memberProvisioning ? { memberProvisioning: policy.policy.memberProvisioning } : {}) };
  if (input.publicationFailed || input.platform !== 'linux' || !input.runtimeId || !input.daemonState || typeof input.daemonState !== 'object'
    || Reflect.get(input.daemonState, 'runtimeId') !== input.runtimeId) {
    return { ...desired, status: unavailable };
  }
  const observed = MachineAgentIsolationStatusV1Schema.safeParse(Reflect.get(input.daemonState, 'agentIsolation'));
  return { ...desired, status: observed.success ? observed.data : unavailable };
}
