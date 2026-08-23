import { machineSpawnNewSessionUntilResolved } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { supportsSpawnPendingFirstInput } from '@/sync/domains/session/spawn/spawnSessionPayload';
import { buildSafeWorkspaceLabel } from '@/utils/worktree/workspaceHandles';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import { postprocessSpawnedSession } from './spawnSessionPostProcess';
import { resolveSpawnAgentIdFromState } from './spawnSessionAgent';
import { isAgentId } from '@/agents/registry/registryCore';
import { resolveVoiceSessionRef } from './sessionReference';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { canAttemptMachineSpawn, resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import {
  resolveMachineTargetForSessionFromState,
  type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';
import {
  completeVoiceSpawnAttemptCustody,
  createVoiceSpawnAttempt,
  readVoiceSpawnedSessionIdForAttempt,
} from '@/voice/shared/voiceSpawnAttempt';

type VoiceSpawnTarget = Readonly<{
  machineId: string;
  directory: string;
  replacementCanonicalized: boolean;
}>;

type SessionSpawnNewActionInput = Parameters<ActionExecutorDeps['sessionSpawnNew']>[0];

function canonicalizeSpawnTarget(
  target: Readonly<{ machineId: string; directory: string }> | null,
  machines: ReadonlyArray<Machine>,
): VoiceSpawnTarget | null {
  if (!target) return null;
  const canonical = resolveCanonicalMachineId(target.machineId, machines);
  const machineId = canonical?.machineId ?? target.machineId;
  return {
    machineId,
    directory: target.directory,
    replacementCanonicalized: canonical?.reason === 'replacement',
  };
}

function resolveSpawnTarget(state: StorageState): VoiceSpawnTarget | null {
  const sessionsObj = state?.sessions ?? {};
  const machines = Object.values(state?.machines ?? {}) as Machine[];
  const voiceTarget = useVoiceTargetStore.getState();
  const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
    .map((v) => normalizeNonEmptyString(v))
    .filter(Boolean) as string[];

  for (const sid of candidates) {
    const resolvedTarget = resolveMachineTargetForSessionFromState(state as SessionMachineTargetState, sid);
    if (resolvedTarget) {
      return canonicalizeSpawnTarget({
        machineId: resolvedTarget.machineId,
        directory: resolvedTarget.basePath,
      }, machines);
    }

    const s = sessionsObj?.[sid] as Session | null | undefined;
    const machineId = normalizeNonEmptyString(s?.metadata?.machineId);
    const directory = normalizeNonEmptyString(s?.metadata?.path);
    if (machineId && directory) return canonicalizeSpawnTarget({ machineId, directory }, machines);
  }

  const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
  const machineId = normalizeNonEmptyString(recent?.machineId);
  const directory = normalizeNonEmptyString(recent?.path);
  if (machineId && directory) return canonicalizeSpawnTarget({ machineId, directory }, machines);

  for (const s of Object.values(sessionsObj) as Session[]) {
    const sessionId = normalizeNonEmptyString(s?.id);
    const resolvedTarget = sessionId
      ? resolveMachineTargetForSessionFromState(state as SessionMachineTargetState, sessionId)
      : null;
    if (resolvedTarget) {
      return canonicalizeSpawnTarget({
        machineId: resolvedTarget.machineId,
        directory: resolvedTarget.basePath,
      }, machines);
    }

    const fallbackMachineId = normalizeNonEmptyString(s?.metadata?.machineId);
    const fallbackDirectory = normalizeNonEmptyString(s?.metadata?.path);
    if (fallbackMachineId && fallbackDirectory) return canonicalizeSpawnTarget({ machineId: fallbackMachineId, directory: fallbackDirectory }, machines);
  }

  return null;
}

export async function spawnSessionForVoiceTool(params: SessionSpawnNewActionInput): Promise<unknown> {
  const state = storage.getState();

  const requestedHost = normalizeNonEmptyString(params.host);
  const machinesObj = state?.machines ?? {};
  const machines = Object.values(machinesObj) as Machine[];
  const fallbackTarget = resolveSpawnTarget(state);
  const requestedMachineId = normalizeNonEmptyString(params.machineId);
  const requestedMachineTarget = requestedMachineId
    ? canonicalizeSpawnTarget({ machineId: requestedMachineId, directory: '' }, machines)
    : null;
  let machineId = requestedMachineTarget?.machineId ?? requestedMachineId ?? fallbackTarget?.machineId ?? null;
  if (requestedHost) {
    const hostMatches = Object.values(machinesObj)
      .filter((machine) => normalizeNonEmptyString(machine?.metadata?.host) === requestedHost);
    const exactMachine = machineId ? machinesObj[machineId] ?? null : null;
    if (hostMatches.length === 0) {
      return { type: 'error', errorCode: 'host_not_found', errorMessage: 'host_not_found', host: requestedHost };
    }

    if (hostMatches.length === 1) {
      machineId = hostMatches[0]?.id ?? null;
    } else if (normalizeNonEmptyString(exactMachine?.metadata?.host) !== requestedHost) {
      return {
        type: 'error',
        errorCode: 'host_ambiguous',
        errorMessage: 'host_ambiguous',
        host: requestedHost,
      };
    }

    if (hostMatches.length > 1 && fallbackTarget?.replacementCanonicalized !== true) {
      return {
        type: 'error',
        errorCode: 'host_ambiguous',
        errorMessage: 'host_ambiguous',
        host: requestedHost,
      };
    }
  }

  const directory = normalizeNonEmptyString(params.directory)
    ?? normalizeNonEmptyString(params.path)
    ?? fallbackTarget?.directory
    ?? null;
  if (!machineId || !directory) {
    return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
  }
  const targetMachine = machinesObj[machineId] ?? null;
  const targetReadiness = resolveMachineSpawnReadiness({
    selectedMachineId: machineId,
    machine: targetMachine,
    requireExactSpawnReadiness: true,
  });
  if (!canAttemptMachineSpawn({ selectedMachineId: machineId, machine: targetMachine, spawnReadiness: targetReadiness })) {
    return {
      type: 'error',
      errorCode: 'spawn_target_unavailable',
      errorMessage: 'spawn_target_unavailable',
      machineId,
      readinessStatus: targetReadiness.status,
    };
  }

  const serverId = getActiveServerSnapshot().serverId;
  if (params.sourceContext && params.backendTarget && params.backendTarget.kind !== 'builtInAgent') {
    return {
      type: 'error',
      errorCode: 'invalid_parameters',
      errorMessage: 'source_context_requires_built_in_agent',
    };
  }
  const requestedAgentId = normalizeNonEmptyString(
    params.backendTarget?.kind === 'builtInAgent' ? params.backendTarget.agentId : params.agentId,
  );
  if (requestedAgentId && !isAgentId(requestedAgentId)) {
    return { type: 'error', errorCode: 'agent_not_found', errorMessage: 'agent_not_found' };
  }
  const agent = requestedAgentId && isAgentId(requestedAgentId) ? requestedAgentId : resolveSpawnAgentIdFromState(state);
  const requestedModelId = normalizeNonEmptyString(params.modelId);
  const modelId = requestedModelId && requestedModelId !== 'default' ? requestedModelId : null;
  const modelUpdatedAt = modelId ? Date.now() : null;
  const machineRecord: Machine | { id: string; metadata: Machine['metadata'] } = state.machines[machineId] ?? { id: machineId, metadata: null };
  const machineMetadata = machineRecord.metadata ?? null;
  const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
    machineMetadata,
    settings: state?.settings ?? {},
  }).mode;
  const targetLabel = buildSafeWorkspaceLabel({
    machineLabel: resolveVoiceMachineLabel(machineRecord),
    path: directory,
  });

  const spawnAttempt = createVoiceSpawnAttempt(normalizeNonEmptyString(params.actionRequestId));
  const initialMessage = normalizeNonEmptyString(params.initialMessage);
  const daemonOwnsFirstTurn = supportsSpawnPendingFirstInput(targetMachine?.daemonState?.startedWithCliVersion);
  const spawned = await machineSpawnNewSessionUntilResolved({
    machineId,
    directory,
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
    ...(params.sourceContext ? { sourceContext: params.sourceContext } : {}),
  });

  const spawnedSessionId = readVoiceSpawnedSessionIdForAttempt(spawned, spawnAttempt);

  const tag = normalizeNonEmptyString(params.tag);
  if (spawnedSessionId) {
    await postprocessSpawnedSession({
      sessionId: spawnedSessionId,
      serverId,
      tag,
      initialMessage: daemonOwnsFirstTurn ? null : initialMessage,
      firstTurnLocalId: spawnAttempt.firstTurnLocalId,
    });
    await completeVoiceSpawnAttemptCustody({
      spawned,
      attempt: spawnAttempt,
      machineId,
      serverId,
    });
  }

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
