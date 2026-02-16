import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export async function listServersForVoiceTool(params: Readonly<{ limit?: number }>): Promise<unknown> {
  const state: any = storage.getState();
  if (state?.settings?.voice?.privacy?.shareDeviceInventory === false) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;

  const items: Array<{ serverId: string; label: string }> = [];
  const seen = new Set<string>();

  const active = normalizeId(getActiveServerSnapshot()?.serverId);
  if (active) {
    seen.add(active);
    items.push({ serverId: active, label: active });
  }

  const byServer = state?.sessionListViewDataByServerId ?? {};
  for (const [serverIdRaw, rows] of Object.entries(byServer)) {
    const serverId = normalizeId(serverIdRaw);
    if (!serverId) continue;
    if (seen.has(serverId)) continue;
    let label = serverId;
    if (Array.isArray(rows)) {
      const first = rows.find((r: any) => r && typeof r === 'object' && typeof (r as any).serverName === 'string') as any;
      if (first?.serverName) label = normalizeId(first.serverName) || label;
    }
    seen.add(serverId);
    items.push({ serverId, label });
    if (items.length >= limit) break;
  }

  return { items };
}
