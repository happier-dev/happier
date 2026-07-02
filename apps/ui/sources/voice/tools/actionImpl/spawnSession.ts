import { machineSpawnNewSession } from '@/sync/ops/machines';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveEffectiveWindowsRemoteSessionLaunchMode } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { resolveSessionListPreferredSessionMetadataFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { buildSafeWorkspaceLabel } from '@/utils/worktree/workspaceHandles';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { resolveMachineExactSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineExactSpawnReadiness';
import {
  resolveMachineTargetForSessionFromState,
  type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';

import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import { postprocessSpawnedSession } from './spawnSessionPostProcess';
import { resolveVoiceToolSpawnBackendTarget } from './spawnSessionAgent';
import { resolveVoiceSessionRef } from './sessionReference';

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

    const metadata = resolveSessionListPreferredSessionMetadataFromState(state, sid);
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

    const metadata = resolveSessionListPreferredSessionMetadataFromState(state, sid);
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
  backendTargetKey?: string;
  path?: string;
  host?: string;
  initialMessage?: string;
}>): Promise<unknown> {
  const state: any = storage.getState();

  const requestedHost = normalizeNonEmptyString(params.host);
  const machinesObj: any = state?.machines ?? {};
  const fallbackTarget = resolveSpawnTarget(state);
  const machines = Object.values(machinesObj as any);
  let requestedHostMachineId: string | null = null;
  if (requestedHost) {
    const hostMatches = machines.filter((machine: any) => normalizeNonEmptyString(machine?.metadata?.host) === requestedHost);
    if (hostMatches.length === 0) {
      return { type: 'error', errorCode: 'host_not_found', errorMessage: 'host_not_found', host: requestedHost };
    }
    if (hostMatches.length > 1) {
      return { type: 'error', errorCode: 'host_ambiguous', errorMessage: 'host_ambiguous', host: requestedHost };
    }
    requestedHostMachineId = normalizeNonEmptyString((hostMatches[0] as any)?.id);
  }
  const preferredMachineId = requestedHostMachineId ?? fallbackTarget?.machineId ?? null;
  const canonical = resolveCanonicalMachineId(preferredMachineId, machines as any);
  const targetMachineId = canonical?.machineId ?? preferredMachineId;

  const machineId = normalizeNonEmptyString(targetMachineId);
  const directory = normalizeNonEmptyString(params.path) ?? fallbackTarget?.directory ?? null;
  if (!machineId || !directory) {
    return { type: 'error', errorCode: 'spawn_target_missing', errorMessage: 'spawn_target_missing' };
  }
  const machineRecord = state?.machines?.[machineId] ?? Object.values(state?.machines ?? {}).find((entry: any) => entry?.id === machineId) ?? null;
  const readiness = resolveMachineExactSpawnReadiness(machineRecord as any, machineId);
  if (readiness.status !== 'ready') {
    return {
      type: 'error',
      errorCode: 'spawn_target_unavailable',
      errorMessage: 'spawn_target_unavailable',
      machineId,
      readinessStatus: readiness.status,
    };
  }

  const serverId = getActiveServerSnapshot().serverId;
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
  const requestedModelId = normalizeNonEmptyString(params.modelId);
  const modelId = requestedModelId && requestedModelId !== 'default' ? requestedModelId : null;
  const modelUpdatedAt = modelId ? Date.now() : null;
  const machineMetadata = (state?.machines?.[machineId] ?? Object.values(state?.machines ?? {}).find((entry: any) => entry?.id === machineId) ?? null)?.metadata ?? null;
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
    backendTarget,
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
