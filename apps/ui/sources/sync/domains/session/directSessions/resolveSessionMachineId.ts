import type { Metadata } from '@/sync/domains/state/storageTypes';

import { readDirectSessionLink } from './readDirectSessionLink';

function normalizeMachineId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const machineId = value.trim();
  return machineId.length > 0 ? machineId : null;
}

export function resolveSessionMachineId(metadata: Metadata | null | undefined): string | null {
  const topLevelMachineId = normalizeMachineId(metadata?.machineId);
  if (topLevelMachineId) return topLevelMachineId;
  return normalizeMachineId(readDirectSessionLink(metadata)?.machineId);
}
