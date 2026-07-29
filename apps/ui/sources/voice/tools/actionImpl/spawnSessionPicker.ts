import {
  completeMachineSpawnAttemptCustody,
  machineSpawnNewSession,
} from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';

import { openVoiceSessionSpawnPicker } from '@/voice/pickers/openVoiceSessionSpawnPicker';
import { resolveVoiceToolSpawnBackendTarget } from './spawnSessionAgent';
import {
  postprocessSpawnedSession,
  resolveVoiceSpawnedFirstTurnLocalId,
} from './spawnSessionPostProcess';
import { resolveVoiceInitialMessageCustody } from './spawnSessionInitialMessage';
import {
  resolveVoiceProviderFeatureGate,
  resolveVoiceSpawnModelSelection,
} from './spawnSessionModelSelection';
import { normalizeNonEmptyString } from './shared';
import { createUiSessionSpawnNonce } from '@/sync/domains/session/spawn/spawnSessionNonce';
import { buildVoiceSpawnUserAttemptId } from '@/voice/shared/voiceSpawnAttempt';

export async function spawnSessionWithPickerForVoiceTool(params: Readonly<{ tag?: string; agentId?: string; modelId?: string; providerConnectionId?: string | null; backendTargetKey?: string; initialMessage?: string }>): Promise<unknown> {
  const picked = await openVoiceSessionSpawnPicker();
  if (!picked) {
    return { ok: false, errorCode: 'user_cancelled', errorMessage: 'user_cancelled' };
  }

  const state: any = storage.getState();
  const serverId = getActiveServerSnapshot().serverId;
  const pickedMachine = state?.machines?.[picked.machineId]
    ?? Object.values(state?.machines ?? {}).find((entry: any) => entry?.id === picked.machineId)
    ?? null;
  const readiness = resolveMachineSpawnReadiness({
    machine: pickedMachine as any,
    selectedMachineId: picked.machineId,
  });
  if (readiness.status !== 'ready') {
    return {
      ok: false,
      errorCode: 'spawn_target_unavailable',
      errorMessage: 'spawn_target_unavailable',
      machineId: picked.machineId,
      readinessStatus: readiness.status,
    };
  }
  const providerFeatureGate = await resolveVoiceProviderFeatureGate({
    providerConnectionId: params.providerConnectionId,
    machineId: picked.machineId,
    serverId,
  });
  if (!providerFeatureGate.ok) {
    return providerFeatureGate;
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
  const modelSelection = resolveVoiceSpawnModelSelection({
    backendTarget,
    modelId: params.modelId,
    providerConnectionId: providerFeatureGate.providerConnectionId,
  });
  const modelId = modelSelection?.ref.modelId ?? null;
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

  const spawnNonce = createUiSessionSpawnNonce();
  const userAttemptId = buildVoiceSpawnUserAttemptId({
    surface: 'voice_picker',
    serverId,
    machineId: picked.machineId,
    directory: picked.directory,
    backendTarget,
    modelSelection,
    initialMessage: initialMessageCustody.initialMessage,
    tag: normalizeNonEmptyString(params.tag),
  });
  const spawned = await machineSpawnNewSession({
    machineId: picked.machineId,
    directory: picked.directory,
    backendTarget,
    serverId,
    ...(windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    spawnNonce,
    userAttemptId,
  });

  const spawnedSessionId =
    spawned && (spawned as any).type === 'success' && typeof (spawned as any).sessionId === 'string'
      ? String((spawned as any).sessionId)
      : null;

  await postprocessSpawnedSession({
    sessionId: spawnedSessionId,
    serverId,
    tag: normalizeNonEmptyString(params.tag),
    initialMessage: initialMessageCustody.initialMessage,
    initialMessageMetaOverrides: initialMessageCustody.initialMessageMetaOverrides,
    firstTurnLocalId:
      spawned.spawnAttemptCustody?.status === 'completed'
        ? spawned.spawnAttemptCustody.firstTurnLocalId
        : resolveVoiceSpawnedFirstTurnLocalId({
            spawned,
            requestedSpawnNonce: spawnNonce,
          }),
  });
  if (spawned.spawnAttemptCustody?.status === 'completed') {
    const completed = await completeMachineSpawnAttemptCustody(spawned.spawnAttemptCustody);
    if (!completed) {
      throw new Error('Created voice session custody could not be completed.');
    }
  }

  return spawned;
}
