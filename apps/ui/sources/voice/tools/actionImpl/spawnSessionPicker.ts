import { machineSpawnNewSession } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveMachineExactSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineExactSpawnReadiness';

import { openVoiceSessionSpawnPicker } from '@/voice/pickers/openVoiceSessionSpawnPicker';
import { resolveVoiceToolSpawnBackendTarget } from './spawnSessionAgent';
import { postprocessSpawnedSession } from './spawnSessionPostProcess';
import { normalizeNonEmptyString } from './shared';

export async function spawnSessionWithPickerForVoiceTool(params: Readonly<{ tag?: string; agentId?: string; modelId?: string; backendTargetKey?: string; initialMessage?: string }>): Promise<unknown> {
  const picked = await openVoiceSessionSpawnPicker();
  if (!picked) {
    return { ok: false, errorCode: 'user_cancelled', errorMessage: 'user_cancelled' };
  }

  const state: any = storage.getState();
  const serverId = getActiveServerSnapshot().serverId;
  const pickedMachine = state?.machines?.[picked.machineId]
    ?? Object.values(state?.machines ?? {}).find((entry: any) => entry?.id === picked.machineId)
    ?? null;
  const readiness = resolveMachineExactSpawnReadiness(pickedMachine as any, picked.machineId);
  if (readiness.status !== 'ready') {
    return {
      ok: false,
      errorCode: 'spawn_target_unavailable',
      errorMessage: 'spawn_target_unavailable',
      machineId: picked.machineId,
      readinessStatus: readiness.status,
    };
  }
  const daemonMergedProjectionInputs = await loadDaemonMergedProjectionInputs({
    machineId: picked.machineId,
    serverId,
  });
  const resolvedBackendTarget = resolveVoiceToolSpawnBackendTarget({
    state,
    agentId: normalizeNonEmptyString(params.agentId),
    backendTargetKey: normalizeNonEmptyString(params.backendTargetKey),
    daemonMergedProjectionInputs,
  });
  if (!resolvedBackendTarget.ok) {
    return { ok: false, errorCode: resolvedBackendTarget.errorCode, errorMessage: resolvedBackendTarget.errorMessage };
  }
  const backendTarget = resolvedBackendTarget.backendTarget;
  const requestedModelId = normalizeNonEmptyString(params.modelId);
  const modelId = requestedModelId && requestedModelId !== 'default' ? requestedModelId : null;
  const modelUpdatedAt = modelId ? Date.now() : null;
  const machineMetadata = pickedMachine?.metadata ?? null;
  const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
    machineMetadata,
    settings: state?.settings ?? {},
  }).mode;

  const spawned = await machineSpawnNewSession({
    machineId: picked.machineId,
    directory: picked.directory,
    backendTarget,
    serverId,
    ...(windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode } : {}),
    ...(modelId ? { modelId, modelUpdatedAt: modelUpdatedAt ?? Date.now() } : {}),
  });

  const spawnedSessionId =
    spawned && (spawned as any).type === 'success' && typeof (spawned as any).sessionId === 'string'
      ? String((spawned as any).sessionId)
      : null;

  await postprocessSpawnedSession({
    sessionId: spawnedSessionId,
    tag: normalizeNonEmptyString(params.tag),
    initialMessage: normalizeNonEmptyString(params.initialMessage),
  });

  return spawned;
}
