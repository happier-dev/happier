import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function resolveVoiceServerLabel(params: Readonly<{
  serverId: string;
  fallbackLabel?: string | null;
  genericLabel: string;
}>): string {
  const serverId = normalizeId(params.serverId);
  const fallbackLabel = normalizeId(params.fallbackLabel);
  const profileName = normalizeId(getServerProfileById(serverId)?.name);
  if (profileName) return profileName;
  if (fallbackLabel && fallbackLabel !== serverId) return fallbackLabel;
  return params.genericLabel;
}

export async function listServersForVoiceTool(params: Readonly<{ limit?: number }>): Promise<unknown> {
  const state: any = storage.getState();
  if (!readVoicePrivacySettings(state?.settings).shareDeviceInventory) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;

  const items: Array<{ serverId: string; label: string }> = [];
  const seen = new Set<string>();
  let unnamedConnectedServerCount = 0;

  const active = normalizeId(getActiveServerSnapshot()?.serverId);
  if (active) {
    seen.add(active);
    items.push({
      serverId: active,
      label: resolveVoiceServerLabel({ serverId: active, genericLabel: 'Current server' }),
    });
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
    const genericLabel = `Connected server ${++unnamedConnectedServerCount}`;
    seen.add(serverId);
    items.push({
      serverId,
      label: resolveVoiceServerLabel({ serverId, fallbackLabel: label, genericLabel }),
    });
    if (items.length >= limit) break;
  }

  return { items };
}
