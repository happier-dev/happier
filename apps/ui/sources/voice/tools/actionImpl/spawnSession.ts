import { machineSpawnNewSession } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { buildSafeWorkspaceLabel } from '@/utils/worktree/workspaceHandles';

import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import { postprocessSpawnedSession } from './spawnSessionPostProcess';
import { resolveSpawnAgentIdFromState } from './spawnSessionAgent';
import { isAgentId } from '@/agents/registry/registryCore';
import { resolveVoiceSessionRef } from './sessionReference';

function resolveSpawnTarget(state: any): { machineId: string; directory: string } | null {
  const sessionsObj = state?.sessions ?? {};
  const voiceTarget = useVoiceTargetStore.getState();
  const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
    .map((v) => normalizeNonEmptyString(v))
    .filter(Boolean) as string[];

  for (const sid of candidates) {
    const s = sessionsObj?.[sid] ?? null;
    const machineId = normalizeNonEmptyString(s?.metadata?.machineId);
    const directory = normalizeNonEmptyString(s?.metadata?.path);
    if (machineId && directory) return { machineId, directory };
  }

  const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
  const machineId = normalizeNonEmptyString(recent?.machineId);
  const directory = normalizeNonEmptyString(recent?.path);
  if (machineId && directory) return { machineId, directory };

  for (const s of Object.values(sessionsObj) as any[]) {
    const fallbackMachineId = normalizeNonEmptyString(s?.metadata?.machineId);
    const fallbackDirectory = normalizeNonEmptyString(s?.metadata?.path);
    if (fallbackMachineId && fallbackDirectory) return { machineId: fallbackMachineId, directory: fallbackDirectory };
  }

  return null;
}

export async function spawnSessionForVoiceTool(params: Readonly<{
  tag?: string;
  agentId?: string;
  modelId?: string;
  path?: string;
  host?: string;
  initialMessage?: string;
}>): Promise<unknown> {
  const state: any = storage.getState();

  const requestedHost = normalizeNonEmptyString(params.host);
  const machinesObj: any = state?.machines ?? {};
  const match = requestedHost
    ? ((Object.values(machinesObj as any).find((m: any) => normalizeNonEmptyString(m?.metadata?.host) === requestedHost) as any) ?? null)
    : null;
  const machineIdFromHost = requestedHost ? (match?.id ?? null) : null;
  if (requestedHost && !normalizeNonEmptyString(machineIdFromHost)) {
    return { type: 'error', errorCode: 'host_not_found', errorMessage: 'host_not_found', host: requestedHost };
  }

  const fallbackTarget = resolveSpawnTarget(state);
  const machineId = normalizeNonEmptyString(machineIdFromHost) ?? fallbackTarget?.machineId ?? null;
  const directory = normalizeNonEmptyString(params.path) ?? fallbackTarget?.directory ?? null;
  if (!machineId || !directory) {
    return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
  }

  const serverId = getActiveServerSnapshot().serverId;
  const requestedAgentId = normalizeNonEmptyString(params.agentId);
  if (requestedAgentId && !isAgentId(requestedAgentId)) {
    return { type: 'error', errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
  }
  const agent = requestedAgentId ? (requestedAgentId as any) : resolveSpawnAgentIdFromState(state);
  const requestedModelId = normalizeNonEmptyString(params.modelId);
  const modelId = requestedModelId && requestedModelId !== 'default' ? requestedModelId : null;
  const modelUpdatedAt = modelId ? Date.now() : null;
  const machineMetadata = (state?.machines?.[machineId] ?? Object.values(state?.machines ?? {}).find((entry: any) => entry?.id === machineId) ?? null)?.metadata ?? null;
  const machineRecord = state?.machines?.[machineId] ?? Object.values(state?.machines ?? {}).find((entry: any) => entry?.id === machineId) ?? { id: machineId, metadata: machineMetadata };
  const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
    machineMetadata,
    settings: state?.settings ?? {},
  }).mode;
  const targetLabel = buildSafeWorkspaceLabel({
    machineLabel: resolveVoiceMachineLabel(machineRecord),
    path: directory,
  });

  const spawned = await machineSpawnNewSession({
    machineId,
    directory,
    backendTarget: { kind: 'builtInAgent', agentId: agent },
    serverId,
    ...(windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode } : {}),
    ...(modelId ? { modelId, modelUpdatedAt: modelUpdatedAt ?? Date.now() } : {}),
  });

  const spawnedSessionId =
    spawned && (spawned as any).type === 'success' && typeof (spawned as any).sessionId === 'string'
      ? String((spawned as any).sessionId)
      : null;

  const tag = normalizeNonEmptyString(params.tag);
  const initialMessage = normalizeNonEmptyString(params.initialMessage);
  await postprocessSpawnedSession({ sessionId: spawnedSessionId, tag, initialMessage });

  if (!spawned || typeof spawned !== 'object' || Array.isArray(spawned)) {
    return spawned;
  }

  const session = spawnedSessionId ? resolveVoiceSessionRef(spawnedSessionId, storage.getState()) : null;

  return {
    ...(spawned as Record<string, unknown>),
    ...(session ? { session } : {}),
    target: { label: targetLabel },
  };
}
