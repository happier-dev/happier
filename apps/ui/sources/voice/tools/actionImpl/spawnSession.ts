import { resolveExplicitSessionSpawnMachineTarget } from '@happier-dev/protocol';
import {
  completeMachineSpawnAttemptCustody,
  machineSpawnNewSession,
} from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { buildSafeWorkspaceLabel } from '@/utils/worktree/workspaceHandles';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';
import {
  resolveMachineTargetForSessionFromState,
  type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';

import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import {
  postprocessSpawnedSession,
  resolveVoiceSpawnedFirstTurnLocalId,
} from './spawnSessionPostProcess';
import { resolveVoiceInitialMessageCustody } from './spawnSessionInitialMessage';
import { resolveVoiceToolSpawnBackendTarget } from './spawnSessionAgent';
import {
  resolveVoiceProviderFeatureGate,
  resolveVoiceSpawnModelSelection,
} from './spawnSessionModelSelection';
import { resolveVoiceSessionRef } from './sessionReference';
import { createUiSessionSpawnNonce } from '@/sync/domains/session/spawn/spawnSessionNonce';
import { buildVoiceSpawnUserAttemptId } from '@/voice/shared/voiceSpawnAttempt';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

function resolveSpawnTarget(state: any): { machineId: string; directory: string } | null {
  const sessionsObj = state?.sessions ?? {};
  const voiceTarget = useVoiceTargetStore.getState();
  const candidates = [voiceTarget.primaryActionSessionId, voiceTarget.lastFocusedSessionId]
    .map((v) => normalizeNonEmptyString(v))
    .filter(Boolean) as string[];

  for (const sid of candidates) {
    const resolvedTarget = resolveMachineTargetForSessionFromState(state as SessionMachineTargetState, sid);
    if (resolvedTarget) {
      return {
        machineId: resolvedTarget.machineId,
        directory: resolvedTarget.basePath,
      };
    }

    const metadata = readVoiceSessionOwnerMetadataFromState(state, sid);
    const machineId = normalizeNonEmptyString(metadata?.machineId);
    const directory = normalizeNonEmptyString(metadata?.path);
    if (machineId && directory) return { machineId, directory };
  }

  const recent = state?.settings?.recentMachinePaths?.[0] ?? null;
  const machineId = normalizeNonEmptyString(recent?.machineId);
  const directory = normalizeNonEmptyString(recent?.path);
  if (machineId && directory) return { machineId, directory };

  for (const sid of Object.keys(sessionsObj)) {
    const resolvedTarget = resolveMachineTargetForSessionFromState(state as SessionMachineTargetState, sid);
    if (resolvedTarget) {
      return {
        machineId: resolvedTarget.machineId,
        directory: resolvedTarget.basePath,
      };
    }

    const metadata = readVoiceSessionOwnerMetadataFromState(state, sid);
    const metadataMachineId = normalizeNonEmptyString(metadata?.machineId);
    const fallbackDirectory = normalizeNonEmptyString(metadata?.path);
    if (metadataMachineId && fallbackDirectory) return { machineId: metadataMachineId, directory: fallbackDirectory };
  }

  return null;
}

export async function spawnSessionForVoiceTool(params: Readonly<{
  tag?: string;
  agentId?: string;
  modelId?: string;
  providerConnectionId?: string | null;
  backendTargetKey?: string;
  machineId?: string | null;
  serverId?: string | null;
  path?: string;
  host?: string;
  initialMessage?: string;
}>): Promise<unknown> {
  const state: any = storage.getState();

  const activeServer = getActiveServerSnapshot();
  const serverId = normalizeNonEmptyString(params.serverId) ?? activeServer.serverId;
  const activeMachines = Object.values(state?.machines ?? {}) as Machine[];
  const requestedMachineId = normalizeNonEmptyString(params.machineId);

  let machineId: string;
  let directory: string;
  let machineRecord: Machine;

  if (requestedMachineId) {
    const serverProfile = getServerProfileById(serverId);
    const serverIdAliases = serverProfile
      ? [serverProfile.id, serverProfile.serverIdentityId, ...(serverProfile.legacyServerIds ?? [])]
          .flatMap((value) => {
            const normalized = normalizeNonEmptyString(value);
            return normalized ? [normalized] : [];
          })
      : [];
    const scopedMachines = resolveServerScopedMachines({
      serverId,
      activeServerId: activeServer.serverId,
      serverIdAliases,
      activeMachines,
      machineListByServerId: (state?.machineListByServerId ?? {}) as Readonly<
        Record<string, ReadonlyArray<Machine> | null | undefined>
      >,
    }) ?? [];
    const explicitTarget = resolveExplicitSessionSpawnMachineTarget({
      machineId: requestedMachineId,
      host: params.host,
      machines: scopedMachines.map((machine) => ({
        machineId: machine.id,
        host: machine.metadata?.host,
      })),
    });
    if (explicitTarget.kind !== 'resolved') {
      return { type: 'error', errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters' };
    }

    const exactMachine = scopedMachines.find((machine) => machine.id === explicitTarget.machineId) ?? null;
    const readiness = resolveMachineSpawnReadiness({
      machine: exactMachine,
      selectedMachineId: explicitTarget.machineId,
    });
    if (readiness.status !== 'ready') {
      return {
        type: 'error',
        errorCode: 'spawn_target_unavailable',
        errorMessage: 'spawn_target_unavailable',
        machineId: explicitTarget.machineId,
        readinessStatus: readiness.status,
      };
    }

    const explicitDirectory = normalizeNonEmptyString(params.path);
    const recentDirectory = explicitDirectory
      ? null
      : getRecentPathsForMachine({
          machineId: explicitTarget.machineId,
          recentMachinePaths: state?.settings?.recentMachinePaths ?? [],
          sessions: Object.values(state?.sessions ?? {}).map((session: any) => ({
            ...session,
            metadata: readVoiceSessionOwnerMetadataFromState(state, session?.id),
          })),
        })[0] ?? null;
    const resolvedDirectory = explicitDirectory ?? recentDirectory;
    if (!resolvedDirectory || !exactMachine) {
      return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
    }

    machineId = explicitTarget.machineId;
    directory = resolvedDirectory;
    machineRecord = exactMachine;
  } else {
    const requestedHost = normalizeNonEmptyString(params.host);
    const fallbackTarget = resolveSpawnTarget(state);
    let requestedHostMachineId: string | null = null;
    if (requestedHost) {
      const hostMatches = activeMachines.filter(
        (machine) => normalizeNonEmptyString(machine.metadata?.host) === requestedHost,
      );
      if (hostMatches.length === 0) {
        return { type: 'error', errorCode: 'host_not_found', errorMessage: 'host_not_found', host: requestedHost };
      }
      if (hostMatches.length > 1) {
        return { type: 'error', errorCode: 'host_ambiguous', errorMessage: 'host_ambiguous', host: requestedHost };
      }
      requestedHostMachineId = normalizeNonEmptyString(hostMatches[0]?.id);
    }
    const preferredMachineId = requestedHostMachineId ?? fallbackTarget?.machineId ?? null;
    const canonical = resolveCanonicalMachineId(preferredMachineId, activeMachines);
    const resolvedMachineId = normalizeNonEmptyString(canonical?.machineId ?? preferredMachineId);
    const resolvedDirectory = normalizeNonEmptyString(params.path) ?? fallbackTarget?.directory ?? null;
    if (!resolvedMachineId || !resolvedDirectory) {
      return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
    }

    const resolvedMachineRecord = activeMachines.find((machine) => machine.id === resolvedMachineId) ?? null;
    const readiness = resolveMachineSpawnReadiness({
      machine: resolvedMachineRecord,
      selectedMachineId: resolvedMachineId,
    });
    if (!resolvedMachineRecord || readiness.status !== 'ready') {
      return {
        type: 'error',
        errorCode: 'spawn_target_unavailable',
        errorMessage: 'spawn_target_unavailable',
        machineId: resolvedMachineId,
        readinessStatus: readiness.status,
      };
    }

    machineId = resolvedMachineId;
    directory = resolvedDirectory;
    machineRecord = resolvedMachineRecord;
  }

  const providerFeatureGate = await resolveVoiceProviderFeatureGate({
    providerConnectionId: params.providerConnectionId,
    machineId,
    serverId,
  });
  if (!providerFeatureGate.ok) {
    return providerFeatureGate;
  }
  const daemonMergedProjectionInputs = await loadDaemonMergedProjectionInputs({
    machineId,
    serverId,
  });
  const resolvedBackendTarget = resolveVoiceToolSpawnBackendTarget({
    state,
    agentId: normalizeNonEmptyString(params.agentId),
    backendTargetKey: normalizeNonEmptyString(params.backendTargetKey),
    daemonMergedProjectionInputs,
  });
  if (!resolvedBackendTarget.ok) {
    return { type: 'error', errorCode: resolvedBackendTarget.errorCode, errorMessage: resolvedBackendTarget.errorMessage };
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
  const machineMetadata = machineRecord.metadata ?? null;
  const windowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
    machineMetadata,
    settings: state?.settings ?? {},
  }).mode;
  const targetLabel = buildSafeWorkspaceLabel({
    machineLabel: resolveVoiceMachineLabel(machineRecord),
    path: directory,
  });

  const spawnNonce = createUiSessionSpawnNonce();
  const userAttemptId = buildVoiceSpawnUserAttemptId({
    surface: 'voice_tool',
    serverId,
    machineId,
    directory,
    backendTarget,
    modelSelection,
    initialMessage: initialMessageCustody.initialMessage,
    tag: normalizeNonEmptyString(params.tag),
  });
  const spawned = await machineSpawnNewSession({
    machineId,
    directory,
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

  const tag = normalizeNonEmptyString(params.tag);
  await postprocessSpawnedSession({
    sessionId: spawnedSessionId,
    serverId,
    tag,
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
