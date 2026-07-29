import { compareMachineHosts } from '../machines/host/normalizeMachineHost.js';

export type SessionSpawnMachineTargetCandidate = Readonly<{
  machineId: string;
  host?: string | null;
}>;

export type ExplicitSessionSpawnMachineTargetResolution =
  | Readonly<{ kind: 'not_explicit' }>
  | Readonly<{ kind: 'resolved'; machineId: string }>
  | Readonly<{ kind: 'invalid'; errorCode: 'invalid_parameters' }>;

export function resolveExplicitSessionSpawnMachineTarget(input: Readonly<{
  machineId?: string | null;
  host?: string | null;
  machines: readonly SessionSpawnMachineTargetCandidate[];
}>): ExplicitSessionSpawnMachineTargetResolution {
  const machineId = String(input.machineId ?? '').trim();
  if (!machineId) return { kind: 'not_explicit' };

  const machine = input.machines.find((candidate) => candidate.machineId.trim() === machineId);
  if (!machine) return { kind: 'invalid', errorCode: 'invalid_parameters' };

  const assertedHost = String(input.host ?? '').trim();
  if (assertedHost && !compareMachineHosts(assertedHost, machine.host)) {
    return { kind: 'invalid', errorCode: 'invalid_parameters' };
  }

  return { kind: 'resolved', machineId };
}
