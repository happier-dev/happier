import { clearServerAccountChangesCursors, updateSettings, type Settings } from '@/persistence';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';

function deleteKey<T extends Record<string, unknown>>(obj: T | undefined, key: string): T | undefined {
  if (!obj) return obj;
  if (!(key in obj)) return obj;
  const next: Record<string, unknown> = { ...obj };
  delete next[key];
  return Object.keys(next).length ? (next as T) : undefined;
}

export function clearServerScopedAuthStateInSettings(settings: Settings, serverId: string): Settings {
  const rawTarget = String(serverId ?? '').trim();
  if (!rawTarget) return settings;
  const target = sanitizeServerIdForFilesystem(rawTarget, 'cloud');

  const nextMachineIds = deleteKey(settings.machineIdByServerId, target);
  const nextMachineIdsByAccountId = deleteKey(settings.machineIdByServerIdByAccountId, target);
  const nextReplacementCandidates = deleteKey(settings.machineReplacementCandidatesByServerIdByAccountId, target);
  const nextLastTokenSubs = deleteKey(settings.lastTokenSubByServerId, target);
  const nextMachineConfirmed = deleteKey(settings.machineIdConfirmedByServerByServerId, target);

  return {
    ...settings,
    machineIdByServerId: nextMachineIds,
    machineIdByServerIdByAccountId: nextMachineIdsByAccountId,
    machineReplacementCandidatesByServerIdByAccountId: nextReplacementCandidates,
    lastTokenSubByServerId: nextLastTokenSubs,
    machineIdConfirmedByServerByServerId: nextMachineConfirmed,
  };
}

export async function clearServerScopedAuthState(serverId: string): Promise<void> {
  if (!serverId.trim()) return;
  await clearServerAccountChangesCursors(serverId);
  await updateSettings(settings => clearServerScopedAuthStateInSettings(settings, serverId));
}
