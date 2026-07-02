import { isSameMachineLocality } from '@happier-dev/protocol';

export type MachineControlLocalityProof = 'exact_machine_id' | 'same_host_home';

export type MachineControlLocalityInput = Readonly<{
  sessionMachineId?: unknown;
  currentMachineId?: unknown;
  sessionHost?: unknown;
  sessionHomeDir?: unknown;
  currentMachineHost?: unknown;
  currentMachineHomeDir?: unknown;
}>;

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveMachineControlLocalityProof(
  input: MachineControlLocalityInput,
): MachineControlLocalityProof | null {
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

  return null;
}
