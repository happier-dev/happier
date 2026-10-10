import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export async function listMachinesForVoiceTool(params: Readonly<{ serverId?: string; limit?: number }>): Promise<unknown> {
  const state = storage.getState();
  if (!readVoicePrivacySettings(state?.settings).shareDeviceInventory) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const activeServerId = getActiveServerSnapshot().serverId;
  const serverId = params.serverId ?? activeServerId;
  const machines = state.machineListByServerId[serverId] ?? (serverId === activeServerId ? Object.values(state.machines) : []);
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;

  const items = machines
    .slice(0, limit)
    .map((m) => ({
      serverId,
      machineId: normalizeNonEmptyString(m?.id),
      label: resolveVoiceMachineLabel(m),
      ...(normalizeNonEmptyString(m?.metadata?.host) ? { host: normalizeNonEmptyString(m?.metadata?.host) } : {}),
      ...(m.access ? { access: m.access } : {}),
    }))
    .filter((m) => m.machineId);

  return { items };
}
