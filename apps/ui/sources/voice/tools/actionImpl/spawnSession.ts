import { machineSpawnNewSession } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

import { normalizeNonEmptyString } from './shared';
import { createWorkspaceId } from '@/utils/worktree/workspaceHandles';
import { postprocessSpawnedSession } from './spawnSessionPostProcess';
import { resolveSpawnAgentIdFromState } from './spawnSessionAgent';
import { isAgentId } from '@/agents/registry/registryCore';

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
  workspaceId?: string;
  agentId?: string;
  modelId?: string;
  path?: string;
  host?: string;
  initialMessage?: string;
}>): Promise<unknown> {
  const state: any = storage.getState();

  const requestedWorkspaceId = normalizeNonEmptyString(params.workspaceId);
  const requestedHost = normalizeNonEmptyString(params.host);
  const machinesObj: any = state?.machines ?? {};
  const match = requestedHost
    ? ((Object.values(machinesObj as any).find((m: any) => normalizeNonEmptyString(m?.metadata?.host) === requestedHost) as any) ?? null)
    : null;
  const machineIdFromHost = requestedHost ? (match?.id ?? null) : null;

  const fallbackTarget = resolveSpawnTarget(state);
  const resolveWorkspaceTarget = async (): Promise<{ machineId: string; directory: string } | null> => {
    if (!requestedWorkspaceId) return null;
    const candidates: Array<{ machineId: string; directory: string }> = [];
    const recent = Array.isArray(state?.settings?.recentMachinePaths) ? (state.settings.recentMachinePaths as any[]) : [];
    for (const entry of recent) {
      const machineId = normalizeNonEmptyString(entry?.machineId);
      const directory = normalizeNonEmptyString(entry?.path);
      if (machineId && directory) candidates.push({ machineId, directory });
    }
    const sessionsObj = state?.sessions ?? {};
    for (const s of Object.values(sessionsObj) as any[]) {
      const machineId = normalizeNonEmptyString(s?.metadata?.machineId);
      const directory = normalizeNonEmptyString(s?.metadata?.path);
      if (machineId && directory) candidates.push({ machineId, directory });
    }

    for (const cand of candidates) {
      const workspaceId = await createWorkspaceId({ machineId: cand.machineId, path: cand.directory });
      if (workspaceId && workspaceId === requestedWorkspaceId) return cand;
    }
    return null;
  };

  const workspaceTarget = await resolveWorkspaceTarget();

  const machineId = workspaceTarget?.machineId ?? normalizeNonEmptyString(machineIdFromHost) ?? fallbackTarget?.machineId ?? null;
  const directory = workspaceTarget?.directory ?? normalizeNonEmptyString(params.path) ?? fallbackTarget?.directory ?? null;
  if (!machineId || !directory) {
    return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
  }
  if (requestedWorkspaceId && !workspaceTarget) {
    return { type: 'error', errorCode: 'workspace_not_found', errorMessage: 'workspace_not_found' };
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

  const spawned = await machineSpawnNewSession({
    machineId,
    directory,
    agent,
    serverId,
    ...(modelId ? { modelId, modelUpdatedAt: modelUpdatedAt ?? Date.now() } : {}),
  });

  const spawnedSessionId =
    spawned && (spawned as any).type === 'success' && typeof (spawned as any).sessionId === 'string'
      ? String((spawned as any).sessionId)
      : null;

  const tag = normalizeNonEmptyString(params.tag);
  const initialMessage = normalizeNonEmptyString(params.initialMessage);
  await postprocessSpawnedSession({ sessionId: spawnedSessionId, tag, initialMessage });

  return spawned;
}
