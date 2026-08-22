import {
  isSameMachineLocality,
  resolveCanonicalMachineId,
  resolveSessionWorkspaceRootForMachine,
} from '@happier-dev/protocol';

import { fetchAccountMachineReplacements } from '@/api/machine/fetchAccountMachineReplacements';

/**
 * Which fact entitles THIS daemon to act for a Session recorded against a
 * machine id, in increasing cost:
 *
 * - `exact_machine_id` — the Session names this machine.
 * - `same_host_home` — the Session names a stale id for the same physical host
 *   (a re-registration), proven by hostname plus home directory.
 * - `canonical_replacement` — this machine REPLACED the Session's machine.
 */
export type MachineControlLocalityProof =
  | 'exact_machine_id'
  | 'same_host_home'
  | 'canonical_replacement';

export type MachineControlLocalityInput = Readonly<{
  sessionMachineId?: unknown;
  currentMachineId?: unknown;
  sessionHost?: unknown;
  sessionHomeDir?: unknown;
  currentMachineHost?: unknown;
  currentMachineHomeDir?: unknown;
  /**
   * Required: the replacement chain lives only on the server, so a caller that
   * could not supply it would silently lose the successor proof rather than
   * fail to compile.
   */
  credentials: Readonly<{ token: string }>;
}>;

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The single daemon-side answer to "may this machine act for the Session
 * recorded against `sessionMachineId`?".
 *
 * A machine REPLACEMENT is not a mismatch. Replacing a machine must not strand
 * the Sessions the previous one hosted, and nothing re-homes a Session row, so
 * its recorded host stays the predecessor forever. Both sides are therefore
 * resolved through {@link resolveCanonicalMachineId} — the same walk the client
 * used to choose this daemon as its RPC target — so the successor recognises
 * its own inheritance instead of reading it as foreign. A replacement is a
 * genuinely new host, so it shares neither hostname nor home directory with its
 * predecessor and cannot earn `same_host_home`.
 *
 * Cost: the chain costs one Account-scoped read, taken ONLY once both free
 * proofs have already failed — that is, only when the machines genuinely look
 * unrelated. An unreadable chain proves no inheritance and keeps the refusal,
 * so every failure here is closed.
 */
export async function resolveMachineControlLocalityProof(
  input: MachineControlLocalityInput,
): Promise<MachineControlLocalityProof | null> {
  const sessionMachineId = readString(input.sessionMachineId);
  const currentMachineId = readString(input.currentMachineId);
  if (sessionMachineId && currentMachineId && sessionMachineId === currentMachineId) {
    return 'exact_machine_id';
  }

  const currentHomeDir = readString(input.currentMachineHomeDir);
  if (isSameMachineLocality({
    sessionHost: readString(input.sessionHost),
    sessionHomeDir: readString(input.sessionHomeDir),
    currentHost: readString(input.currentMachineHost),
    currentHomeDir,
    homeDir: currentHomeDir,
  })) {
    return 'same_host_home';
  }

  if (!sessionMachineId || !currentMachineId) return null;
  const machines = await fetchAccountMachineReplacements({ credentials: input.credentials });
  if (!machines) return null;
  const canonicalSessionMachineId = resolveCanonicalMachineId(sessionMachineId, machines)?.machineId
    ?? sessionMachineId;
  const canonicalCurrentMachineId = resolveCanonicalMachineId(currentMachineId, machines)?.machineId
    ?? currentMachineId;
  return canonicalSessionMachineId === canonicalCurrentMachineId ? 'canonical_replacement' : null;
}

/** Resolves a session workspace root for an operation executed by this daemon. */
export function resolveSessionMachineWorkspacePath(params: Readonly<{
  metadata: Record<string, unknown>;
  currentMachineId?: unknown;
  candidatePath?: unknown;
}>): string | null {
  const candidatePath = readString(params.candidatePath);
  if (!candidatePath) return null;
  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) return candidatePath;
  return resolveSessionWorkspaceRootForMachine({
    metadata: params.metadata,
    machineId: currentMachineId,
    candidatePath,
  }).machinePath;
}
