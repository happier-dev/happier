import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isMachineReplaced } from './identity/canonicalMachineId.js';
import { isMachineRoleActiveV1 } from './roles/machineRolesV1.js';

const machineId = z.string().check(z.trim(), z.minLength(1));
export const MachineSpawnReadinessV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('missing') }),
  z.strictObject({ status: z.literal('ready'), machineId }),
  z.strictObject({ status: z.literal('revoked'), machineId }),
  z.strictObject({ status: z.literal('offline'), machineId }),
  z.strictObject({ status: z.literal('unknown'), machineId }),
  z.strictObject({ status: z.literal('rpcUnavailable'), machineId }),
  z.strictObject({ status: z.literal('keyUnavailable'), machineId }),
  z.strictObject({ status: z.literal('replaced'), machineId, replacedByMachineId: machineId }),
  /** The Machine's owner turned its Sessions role off; it refuses spawns, so it is never a launch target. */
  z.strictObject({ status: z.literal('roleInactive'), machineId, roleId: z.literal('sessions') }),
]));
export type MachineSpawnReadinessV1 = z.infer<typeof MachineSpawnReadinessV1Schema>;
export type MachineReadinessProbeStateV1 = boolean | 'unknown' | null | undefined;

/** Reachability is supplied by the qualified transport owner, never inferred from setup. */
export function resolveMachineSpawnReadinessV1(input: Readonly<{
  selectedMachineId?: string | null;
  machine?: Readonly<{ id: string; revokedAt?: number | null; replacedByMachineId?: string | null;
    availability?: Readonly<{ kind: 'available' | 'locked' }> | null;
    /** Opened Machine metadata; its role set is read by the one roles owner. */
    metadata?: unknown }> | null;
  machineReachable: boolean;
  rpcAvailable?: MachineReadinessProbeStateV1;
  keyAvailable?: MachineReadinessProbeStateV1;
  requireExactSpawnReadiness?: boolean;
}>): MachineSpawnReadinessV1 {
  const id = input.selectedMachineId?.trim();
  const machine = input.machine;
  if (!id || !machine) return { status: 'missing' };
  if (typeof machine.revokedAt === 'number' && Number.isFinite(machine.revokedAt) && machine.revokedAt > 0) return { status: 'revoked', machineId: id };
  if (isMachineReplaced(machine)) return { status: 'replaced', machineId: id, replacedByMachineId: machine.replacedByMachineId!.trim() };
  if (machine.metadata != null && !isMachineRoleActiveV1(machine.metadata, 'sessions')) return { status: 'roleInactive', machineId: id, roleId: 'sessions' };
  if (!input.machineReachable) return { status: 'offline', machineId: id };
  if (machine.availability?.kind === 'locked') return { status: 'keyUnavailable', machineId: id };
  if (input.requireExactSpawnReadiness && (input.keyAvailable === undefined || input.rpcAvailable === undefined)) return { status: 'unknown', machineId: id };
  if (input.keyAvailable === 'unknown' || input.rpcAvailable === 'unknown' || input.keyAvailable === null || input.rpcAvailable === null) return { status: 'unknown', machineId: id };
  if (input.keyAvailable === false) return { status: 'keyUnavailable', machineId: id };
  if (input.rpcAvailable === false) return { status: 'rpcUnavailable', machineId: id };
  return { status: 'ready', machineId: id };
}
