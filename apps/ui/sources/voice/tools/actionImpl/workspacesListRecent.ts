import { storage } from '@/sync/domains/state/storage';
import { createWorkspaceId, buildSafeWorkspaceLabel } from '@/utils/worktree/workspaceHandles';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function normalizePath(raw: unknown): string {
  return String(raw ?? '').trim();
}

function safeMachineLabel(machine: any): string {
  const displayName = normalizeId(machine?.metadata?.displayName);
  if (displayName) return displayName;
  const host = normalizeId(machine?.metadata?.host);
  if (host) return host;
  return normalizeId(machine?.id) || 'machine';
}

export async function listRecentWorkspacesForVoiceTool(params: Readonly<{ limit?: number }>): Promise<unknown> {
  const state: any = storage.getState();
  if (state?.settings?.voice?.privacy?.shareDeviceInventory === false) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }

  const recent = Array.isArray(state?.settings?.recentMachinePaths)
    ? (state.settings.recentMachinePaths as any[])
    : [];
  const sessionsObj: any = state?.sessions ?? {};
  const machinesObj: any = state?.machines ?? {};

  const out: Array<{ workspaceId: string; label: string; lastUsedAt: number }> = [];
  const seen = new Set<string>();
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 10;

  for (const entry of recent) {
    const machineId = normalizeId(entry?.machineId);
    const path = normalizePath(entry?.path);
    if (!machineId || !path) continue;
    const key = `${machineId}\n${path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const workspaceId = await createWorkspaceId({ machineId, path });
    if (!workspaceId) continue;

    let lastUsedAt = 0;
    for (const s of Object.values(sessionsObj) as any[]) {
      if (!s || typeof s !== 'object') continue;
      const sm = normalizeId(s?.metadata?.machineId);
      const sp = normalizePath(s?.metadata?.path);
      if (sm !== machineId) continue;
      if (sp !== path) continue;
      const updatedAtRaw = Number(s?.updatedAt ?? 0);
      const updatedAt = Number.isFinite(updatedAtRaw) ? Math.floor(updatedAtRaw) : 0;
      if (updatedAt > lastUsedAt) lastUsedAt = updatedAt;
    }

    const machine = machinesObj?.[machineId] ?? { id: machineId };
    const label = buildSafeWorkspaceLabel({ machineLabel: safeMachineLabel(machine), path });

    out.push({ workspaceId, label, lastUsedAt });
    if (out.length >= limit) break;
  }

  return { items: out };
}
