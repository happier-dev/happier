import { readDirectSessionLink } from './readDirectSessionLink';

function normalizeMachineId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const machineId = value.trim();
  return machineId.length > 0 ? machineId : null;
}

function readTopLevelMachineId(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  return (metadata as { machineId?: unknown }).machineId;
}

export function resolveSessionMachineId(metadata: unknown): string | null {
  const topLevelMachineId = normalizeMachineId(readTopLevelMachineId(metadata));
  if (topLevelMachineId) return topLevelMachineId;
  return normalizeMachineId(readDirectSessionLink(metadata)?.machineId);
}
