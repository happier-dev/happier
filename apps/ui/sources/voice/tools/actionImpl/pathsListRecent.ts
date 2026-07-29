import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { readDisplayMachineIdForSession, readDisplayPathForSession } from '@/sync/ops/sessionMachineTarget';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';
import { buildSafeWorkspaceLabel, buildSafeWorkspaceLabels } from '@/utils/worktree/workspaceHandles';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

function resolveDefaultMachineId(state: any): string | null {
  const machines = Object.values(state?.machines ?? {}) as Array<{ id: string; replacedByMachineId?: string | null; replacedAt?: unknown }>;
  const sessionsObj = state?.sessions ?? {};
  const voiceTarget = useVoiceTargetStore.getState();
  const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
    .map((v) => normalizeNonEmptyString(v))
    .filter(Boolean) as string[];

  for (const sid of candidates) {
    const s = sessionsObj?.[sid] ?? null;
    const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, sid);
    const machineId = readDisplayMachineIdForSession({
      sessionId: sid,
      metadata: ownerMetadata,
    }) || normalizeNonEmptyString(ownerMetadata?.machineId);
    if (machineId) return machineId;
  }

  const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
  const machineId = normalizeNonEmptyString(recent?.machineId);
  if (machineId) return resolveCanonicalMachineId(machineId, machines)?.machineId ?? machineId;
  return null;
}

export async function listRecentPathsForVoiceTool(params: Readonly<{ machineId?: string; limit?: number }>): Promise<unknown> {
  const state: any = storage.getState();
  const voicePrivacy = readVoicePrivacySettings(state?.settings);
  if (!voicePrivacy.shareDeviceInventory) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const shareFilePaths = voicePrivacy.shareFilePaths;
  const sessionsById: Record<string, Session> = state?.sessions ?? {};
  const sessions = Object.values(sessionsById).map((session) => ({
    ...session,
    metadata: readVoiceSessionOwnerMetadataFromState(state, session.id),
  }));
  const recentMachinePaths = Array.isArray(state?.settings?.recentMachinePaths)
    ? (state.settings.recentMachinePaths as any[])
    : [];

  const targetMachineId = normalizeNonEmptyString(params.machineId) || resolveDefaultMachineId(state) || '';
  if (!targetMachineId) return { items: [] };

  const machinesObj: any = state?.machines ?? {};
  const machine = machinesObj?.[targetMachineId] ?? { id: targetMachineId };
  const machineLabel = resolveVoiceMachineLabel(machine);

  const recentPaths = getRecentPathsForMachine({
    machineId: targetMachineId,
    recentMachinePaths,
    sessions,
  });

  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 10;
  const limitedRecentPaths = recentPaths.slice(0, limit);
  const safeLabels = shareFilePaths ? null : buildSafeWorkspaceLabels({ machineLabel, paths: limitedRecentPaths });

  const items: Array<{ label: string; lastUsedAt: number; machineId?: string; path?: string }> = [];
  for (const path of limitedRecentPaths) {
    const label = shareFilePaths ? path : (safeLabels?.get(path) ?? buildSafeWorkspaceLabel({ machineLabel, path }));
    const lastUsedAt = (() => {
      let best = 0;
      for (const s of sessions as any[]) {
        if (!s || typeof s !== 'object') continue;
        const sessionId = typeof s.id === 'string' ? s.id : '';
        const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, sessionId);
        const sessionMachineId =
          readDisplayMachineIdForSession({
            sessionId,
            metadata: ownerMetadata,
          })
          ?? normalizeNonEmptyString(ownerMetadata?.machineId);
        if (sessionMachineId !== targetMachineId) continue;
        const sessionPath =
          readDisplayPathForSession({
            sessionId,
            metadata: ownerMetadata,
          })
          || normalizeNonEmptyString(ownerMetadata?.path);
        if (sessionPath !== path) continue;
        const updatedAtRaw = Number(s?.updatedAt ?? 0);
        const updatedAt = Number.isFinite(updatedAtRaw) ? Math.floor(updatedAtRaw) : 0;
        if (updatedAt > best) best = updatedAt;
      }
      return best;
    })();
    items.push({
      label,
      lastUsedAt,
      ...(shareFilePaths ? { machineId: targetMachineId, path } : {}),
    });
  }

  return { items };
}
