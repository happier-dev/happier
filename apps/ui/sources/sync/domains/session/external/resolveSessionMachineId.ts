import { readExternalSessionLink } from './readExternalSessionLink';
import { readSessionWorkspaceLocationFromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';

function normalizeMachineId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const machineId = value.trim();
  return machineId.length > 0 ? machineId : null;
}

function readTopLevelMachineId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  return normalizeMachineId((metadata as { machineId?: unknown }).machineId);
}

export function resolveSessionMachineId(metadata: unknown): string | null {
  const topLevelMachineId = readTopLevelMachineId(metadata);
  if (topLevelMachineId) return topLevelMachineId;
  const workspaceMachineId = readSessionWorkspaceLocationFromMetadata({ metadata })?.machineId;
  if (workspaceMachineId) return normalizeMachineId(workspaceMachineId);
  return normalizeMachineId(readExternalSessionLink(metadata)?.machineId);
}
