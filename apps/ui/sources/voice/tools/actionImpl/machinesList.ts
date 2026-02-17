import { storage } from '@/sync/domains/state/storage';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function safeMachineLabel(machine: any): string {
  const displayName = normalizeId(machine?.metadata?.displayName);
  if (displayName) return displayName;
  const host = normalizeId(machine?.metadata?.host);
  if (host) return host;
  return normalizeId(machine?.id) || 'machine';
}

export async function listMachinesForVoiceTool(params: Readonly<{ limit?: number }>): Promise<unknown> {
  const state: any = storage.getState();
  if (state?.settings?.voice?.privacy?.shareDeviceInventory === false) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const machinesObj: any = state?.machines ?? {};
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;

  const items = Object.values(machinesObj)
    .filter((m: any) => m && typeof m === 'object')
    .slice(0, limit)
    .map((m: any) => ({
      machineId: normalizeId(m?.id),
      label: safeMachineLabel(m),
      ...(normalizeId(m?.metadata?.host) ? { host: normalizeId(m?.metadata?.host) } : {}),
    }))
    .filter((m: any) => m.machineId);

  return { items };
}
