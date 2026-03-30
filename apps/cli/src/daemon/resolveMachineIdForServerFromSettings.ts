import type { Settings } from '@/persistence';

type MachineIdSettings = Pick<Settings, 'machineIdByServerId' | 'machineIdByServerIdByAccountId'>;

function normalizeMachineId(raw: string | undefined | null): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value ? value : null;
}

export function resolveMachineIdForServerFromSettings(
  settings: MachineIdSettings,
  serverId: string,
  accountId: string | null,
): string | null {
  const scopedByAccount = settings.machineIdByServerIdByAccountId?.[serverId];
  if (scopedByAccount && typeof scopedByAccount === 'object') {
    if (!accountId) return null;
    return normalizeMachineId(scopedByAccount[accountId] ?? null);
  }

  return normalizeMachineId(settings.machineIdByServerId?.[serverId] ?? null);
}
