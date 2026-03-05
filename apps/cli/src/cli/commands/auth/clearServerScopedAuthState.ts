import type { Settings } from '@/persistence';

function deleteKey<T extends Record<string, unknown>>(obj: T | undefined, key: string): T | undefined {
  if (!obj) return obj;
  if (!(key in obj)) return obj;
  const next: Record<string, unknown> = { ...obj };
  delete next[key];
  return Object.keys(next).length ? (next as T) : undefined;
}

export function clearServerScopedAuthStateInSettings(settings: Settings, serverId: string): Settings {
  const target = String(serverId ?? '').trim();
  if (!target) return settings;

  const nextMachineIds = deleteKey(settings.machineIdByServerId, target) ?? {};
  const nextMachineIdsByAccountId = deleteKey(settings.machineIdByServerIdByAccountId, target) ?? {};
  const nextLastTokenSubs = deleteKey(settings.lastTokenSubByServerId, target) ?? {};
  const nextMachineConfirmed = deleteKey(settings.machineIdConfirmedByServerByServerId, target) ?? {};
  const nextCursors = deleteKey(settings.lastChangesCursorByServerIdByAccountId, target) ?? {};

  return {
    ...settings,
    machineIdByServerId: nextMachineIds,
    machineIdByServerIdByAccountId: nextMachineIdsByAccountId,
    lastTokenSubByServerId: nextLastTokenSubs,
    machineIdConfirmedByServerByServerId: nextMachineConfirmed,
    lastChangesCursorByServerIdByAccountId: nextCursors,
  };
}
