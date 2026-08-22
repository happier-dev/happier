import type { BackendTargetRefV1, BackendTargetRefV2, BackendTargetRefV2Input } from '@happier-dev/protocol';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { resolveConcreteCompatBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
  isLegacyConfiguredBackendAgentCompatible,
  isLegacyConfiguredBackendSentinelId,
  LEGACY_REPLAY_BACKEND_TARGET_REQUIRED_ERROR,
  readLegacyConfiguredBackendIdFromLegacyAgent,
  readLegacyReplayCompatBackendTargetInput,
} from '@/session/backendTargets/compat/legacyConfiguredBackend';

export type ContinueWithReplayBackendTargetResolution =
  | Readonly<{
      ok: true;
      backendTargetV2: BackendTargetRefV2;
      backendTarget: BackendTargetRefV1;
      replayFlavor: string;
      agentHintAgentId: string;
    }>
  | Readonly<{
      ok: false;
      errorMessage: string;
    }>;

export function resolveContinueWithReplayBackendTarget(params: Readonly<{
  agent?: string;
  backendTarget?: BackendTargetRefV2Input | null;
}>): ContinueWithReplayBackendTargetResolution {
  const legacyAgent = typeof params.agent === 'string' ? params.agent.trim() : '';
  const rawBackendTarget = params.backendTarget ?? null;
  const backendTarget = resolveConcreteCompatBackendTargetRefs(rawBackendTarget);

  if (!backendTarget) {
    if (rawBackendTarget !== null) {
      return { ok: false, errorMessage: 'Unknown agent id' };
    }
    if (!legacyAgent) {
      return { ok: false, errorMessage: 'agent or backendTarget is required' };
    }
    const compatBackendTargetInput = readLegacyReplayCompatBackendTargetInput(legacyAgent);
    if (compatBackendTargetInput?.sourceKind === 'configured') {
      const refs = resolveConcreteCompatBackendTargetRefs(compatBackendTargetInput);
      if (!refs) {
        return { ok: false, errorMessage: 'Unknown agent id' };
      }
      const configuredBackendId = readLegacyConfiguredBackendIdFromLegacyAgent(legacyAgent);
      if (!configuredBackendId) {
        return {
          ok: true,
          backendTargetV2: refs.backendTargetV2,
          backendTarget: refs.backendTarget,
          replayFlavor: refs.backendTargetV2.backendId,
          agentHintAgentId: refs.backendTargetV2.backendId,
        };
      }
      return {
        ok: true,
        backendTargetV2: refs.backendTargetV2,
        backendTarget: refs.backendTarget,
        replayFlavor: `acp:${configuredBackendId}`,
        agentHintAgentId: `acp:${configuredBackendId}`,
      };
    }
    if (isLegacyConfiguredBackendSentinelId(legacyAgent)) {
      return { ok: false, errorMessage: LEGACY_REPLAY_BACKEND_TARGET_REQUIRED_ERROR };
    }
    if (!isCatalogAgentId(legacyAgent)) {
      return { ok: false, errorMessage: 'Unknown agent id' };
    }
    return {
      ok: true,
      backendTargetV2: {
        kind: 'backend',
        backendId: legacyAgent,
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: legacyAgent },
      replayFlavor: legacyAgent,
      agentHintAgentId: legacyAgent,
    };
  }

  if (backendTarget.backendTargetV2.sourceKind === 'built_in') {
    const backendId = backendTarget.backendTargetV2.backendId;
    if (!isCatalogAgentId(backendId)) {
      return { ok: false, errorMessage: 'Unknown agent id' };
    }
    if (legacyAgent && legacyAgent !== backendId) {
      return { ok: false, errorMessage: 'agent must match backendTarget' };
    }
    return {
      ok: true,
      backendTargetV2: backendTarget.backendTargetV2,
      backendTarget: backendTarget.backendTarget,
      replayFlavor: backendId,
      agentHintAgentId: backendId,
    };
  }

  const configuredBackendId = backendTarget.backendTargetV2.configuredBackendId ?? backendTarget.backendTargetV2.backendId;
  const isCompatibleLegacyConfiguredAgent = isLegacyConfiguredBackendAgentCompatible({
    legacyAgent,
    configuredBackendId,
  });
  if (!isCompatibleLegacyConfiguredAgent) {
    return { ok: false, errorMessage: 'agent must match backendTarget' };
  }

  return {
    ok: true,
    backendTargetV2: backendTarget.backendTargetV2,
    backendTarget: backendTarget.backendTarget,
    replayFlavor: `acp:${configuredBackendId}`,
    agentHintAgentId: `acp:${configuredBackendId}`,
  };
}
