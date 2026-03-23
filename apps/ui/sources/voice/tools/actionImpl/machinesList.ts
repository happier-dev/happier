import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';

export async function listMachinesForVoiceTool(params: Readonly<{ limit?: number }>): Promise<unknown> {
  const state: any = storage.getState();
  if (!readVoicePrivacySettings(state?.settings).shareDeviceInventory) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const machinesObj: any = state?.machines ?? {};
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;

  const items = Object.values(machinesObj)
    .filter((m: any) => m && typeof m === 'object')
    .slice(0, limit)
    .map((m: any) => ({
      machineId: normalizeNonEmptyString(m?.id),
      label: resolveVoiceMachineLabel(m),
      ...(normalizeNonEmptyString(m?.metadata?.host) ? { host: normalizeNonEmptyString(m?.metadata?.host) } : {}),
    }))
    .filter((m: any) => m.machineId);

  return { items };
}
