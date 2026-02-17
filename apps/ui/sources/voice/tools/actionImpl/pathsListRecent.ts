import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';
import { buildSafeWorkspaceLabel, createWorkspaceId } from '@/utils/worktree/workspaceHandles';
import type { Session } from '@/sync/domains/state/storageTypes';

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

function resolveDefaultMachineId(state: any): string | null {
  const sessionsObj = state?.sessions ?? {};
  const voiceTarget = useVoiceTargetStore.getState();
  const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
    .map((v) => normalizeId(v))
    .filter(Boolean) as string[];

  for (const sid of candidates) {
    const s = sessionsObj?.[sid] ?? null;
    const machineId = normalizeId(s?.metadata?.machineId);
    if (machineId) return machineId;
  }

  const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
  const machineId = normalizeId(recent?.machineId);
  if (machineId) return machineId;
  return null;
}

export async function listRecentPathsForVoiceTool(params: Readonly<{ machineId?: string; limit?: number }>): Promise<unknown> {
  const state: any = storage.getState();
  if (state?.settings?.voice?.privacy?.shareDeviceInventory === false) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const shareFilePaths = state?.settings?.voice?.privacy?.shareFilePaths === true;
  const sessionsById: Record<string, Session> = state?.sessions ?? {};
  const sessions = Object.values(sessionsById);
  const recentMachinePaths = Array.isArray(state?.settings?.recentMachinePaths)
    ? (state.settings.recentMachinePaths as any[])
    : [];

  const targetMachineId = normalizeId(params.machineId) || resolveDefaultMachineId(state) || '';
  if (!targetMachineId) return { items: [] };

  const machinesObj: any = state?.machines ?? {};
  const machine = machinesObj?.[targetMachineId] ?? { id: targetMachineId };
  const machineLabel = safeMachineLabel(machine);

  const recentPaths = getRecentPathsForMachine({
    machineId: targetMachineId,
    recentMachinePaths,
    sessions,
  });

  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 10;

  const items: Array<{ workspaceId: string; label: string; lastUsedAt: number; machineId?: string; path?: string }> = [];
  for (const path of recentPaths.slice(0, limit)) {
    const workspaceId = await createWorkspaceId({ machineId: targetMachineId, path });
    if (!workspaceId) continue;
    const label = shareFilePaths ? path : buildSafeWorkspaceLabel({ machineLabel, path });
    const lastUsedAt = (() => {
      let best = 0;
      for (const s of sessions as any[]) {
        if (!s || typeof s !== 'object') continue;
        if (normalizeId(s?.metadata?.machineId) !== targetMachineId) continue;
        if (String(s?.metadata?.path ?? '') !== path) continue;
        const updatedAtRaw = Number(s?.updatedAt ?? 0);
        const updatedAt = Number.isFinite(updatedAtRaw) ? Math.floor(updatedAtRaw) : 0;
        if (updatedAt > best) best = updatedAt;
      }
      return best;
    })();
    items.push({
      workspaceId,
      label,
      lastUsedAt,
      ...(shareFilePaths ? { machineId: targetMachineId, path } : {}),
    });
  }

  return { items };
}
