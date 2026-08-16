import { machineSpawnNewSessionUntilResolved } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { supportsSpawnPendingFirstInput } from '@/sync/domains/session/spawn/spawnSessionPayload';
import { canAttemptMachineSpawn, resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';

import { openVoiceSessionSpawnPicker } from '@/voice/pickers/openVoiceSessionSpawnPicker';
import { resolveSpawnAgentIdFromState } from './spawnSessionAgent';
import { postprocessSpawnedSession } from './spawnSessionPostProcess';
import { normalizeNonEmptyString } from './shared';
import { isAgentId } from '@/agents/registry/registryCore';
import {
  completeVoiceSpawnAttemptCustody,
  createVoiceSpawnAttempt,
  readVoiceSpawnedSessionIdForAttempt,
} from '@/voice/shared/voiceSpawnAttempt';

export async function spawnSessionWithPickerForVoiceTool(params: Readonly<{ tag?: string; agentId?: string; modelId?: string; initialMessage?: string }>): Promise<unknown> {
  const picked = await openVoiceSessionSpawnPicker();
  if (!picked) {
    return { ok: false, errorCode: 'user_cancelled', errorMessage: 'user_cancelled' };
  }

  const state: any = storage.getState();
  const serverId = getActiveServerSnapshot().serverId;
  const requestedAgentId = normalizeNonEmptyString(params.agentId);
  if (requestedAgentId && !isAgentId(requestedAgentId)) {
    return { ok: false, errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
  }
  const agent = requestedAgentId ? (requestedAgentId as any) : resolveSpawnAgentIdFromState(state);
  const requestedModelId = normalizeNonEmptyString(params.modelId);
  const modelId = requestedModelId && requestedModelId !== 'default' ? requestedModelId : null;
  const modelUpdatedAt = modelId ? Date.now() : null;
  const pickedMachine = state?.machines?.[picked.machineId] ?? Object.values(state?.machines ?? {}).find((entry: any) => entry?.id === picked.machineId) ?? null;
  const readiness = resolveMachineSpawnReadiness({
    selectedMachineId: picked.machineId,
    machine: pickedMachine,
    requireExactSpawnReadiness: true,
  });
  if (!canAttemptMachineSpawn({ selectedMachineId: picked.machineId, machine: pickedMachine, spawnReadiness: readiness })) {
    return {
      ok: false,
      errorCode: 'spawn_target_unavailable',
      errorMessage: 'spawn_target_unavailable',
      readinessStatus: readiness.status,
    };
  }
  const machineMetadata = pickedMachine?.metadata ?? null;
  const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
    machineMetadata,
    settings: state?.settings ?? {},
  }).mode;

  const spawnAttempt = createVoiceSpawnAttempt();
  const initialMessage = normalizeNonEmptyString(params.initialMessage);
  const daemonOwnsFirstTurn = supportsSpawnPendingFirstInput(pickedMachine?.daemonState?.startedWithCliVersion);
  const spawned = await machineSpawnNewSessionUntilResolved({
    machineId: picked.machineId,
    directory: picked.directory,
    backendTarget: { kind: 'builtInAgent', agentId: agent },
    serverId,
    userAttemptId: spawnAttempt.userAttemptId,
    firstTurnLocalId: spawnAttempt.firstTurnLocalId,
    attachmentMessageLocalId: spawnAttempt.attachmentMessageLocalId,
    ...(daemonOwnsFirstTurn && initialMessage
      ? { pendingFirstInput: { text: initialMessage, localId: spawnAttempt.firstTurnLocalId } }
      : {}),
    ...(windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode } : {}),
    ...(modelId ? { modelId, modelUpdatedAt: modelUpdatedAt ?? Date.now() } : {}),
  });

  const spawnedSessionId = readVoiceSpawnedSessionIdForAttempt(spawned, spawnAttempt);

  if (spawnedSessionId) {
    await postprocessSpawnedSession({
      sessionId: spawnedSessionId,
      serverId,
      tag: normalizeNonEmptyString(params.tag),
      initialMessage: daemonOwnsFirstTurn ? null : initialMessage,
      firstTurnLocalId: spawnAttempt.firstTurnLocalId,
    });
    await completeVoiceSpawnAttemptCustody({
      spawned,
      attempt: spawnAttempt,
      machineId: picked.machineId,
      serverId,
    });
  }

  return spawned;
}
