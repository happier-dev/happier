import { machineSpawnNewSession } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { createSpawnAttemptKey } from '@/sync/domains/session/spawn/spawnAttemptKey';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveMachineExactSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineExactSpawnReadiness';

import { openVoiceSessionSpawnPicker } from '@/voice/pickers/openVoiceSessionSpawnPicker';
import { resolveVoiceToolSpawnBackendTarget } from './spawnSessionAgent';
import {
  didSpawnUseDaemonInitialPrompt,
  postprocessSpawnedSession,
} from './spawnSessionPostProcess';
import { resolveVoiceInitialMessageCustody } from './spawnSessionInitialMessage';
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
  const initialMessageCustody = resolveVoiceInitialMessageCustody({
    initialMessage: params.initialMessage,
    agentId: params.agentId,
    backendTarget,
    modelId,
  });
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
    spawnAttemptKey: createSpawnAttemptKey('voice.tool.spawn-session-picker', {
      machineId: picked.machineId,
      directory: picked.directory,
      backendTarget,
      serverId,
      tag: normalizeNonEmptyString(params.tag),
      modelId,
      initialMessage: initialMessageCustody.initialMessage,
      daemonInitialPrompt: initialMessageCustody.daemonInitialPrompt,
      initialMessageMetaOverrides: initialMessageCustody.initialMessageMetaOverrides,
      windowsRemoteSessionLaunchMode,
    }),
    ...(windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode } : {}),
    ...(modelId ? { modelId, modelUpdatedAt: modelUpdatedAt ?? Date.now() } : {}),
    ...(initialMessageCustody.daemonInitialPrompt ? { initialPrompt: initialMessageCustody.daemonInitialPrompt } : {}),
  });

  const spawnedSessionId =
    spawned && (spawned as any).type === 'success' && typeof (spawned as any).sessionId === 'string'
      ? String((spawned as any).sessionId)
      : null;

  const daemonInitialPromptUsed = didSpawnUseDaemonInitialPrompt(spawned);
  await postprocessSpawnedSession({
    sessionId: spawnedSessionId,
    serverId,
    tag: normalizeNonEmptyString(params.tag),
    initialMessage: initialMessageCustody.initialMessage,
    initialMessageMetaOverrides: initialMessageCustody.initialMessageMetaOverrides,
    daemonInitialPromptUsed,
  });

  return spawned;
}
