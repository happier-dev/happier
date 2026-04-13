import type { BackendTargetRefV1, BackendTargetRefV2, BackendTargetRefV2Input } from '@happier-dev/protocol';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { isLegacyCustomAcpId } from '@/agent/runtime/compat/isLegacyCustomAcpId';
import { resolveConcreteBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';

export type ContinueWithReplayBackendTargetResolution =
  | Readonly<{
      ok: true;
      backendTargetV2: BackendTargetRefV2;
      backendTarget: BackendTargetRefV1;
      replayFlavor: string;
      providerHintAgentId: CatalogAgentId;
    }>
  | Readonly<{
      ok: false;
      errorMessage: string;
    }>;

function isCatalogAgentId(value: string): value is CatalogAgentId {
  return value !== 'customAcp' && (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

export function resolveContinueWithReplayBackendTarget(params: Readonly<{
  agent?: string;
  backendTarget?: BackendTargetRefV2Input | null;
}>): ContinueWithReplayBackendTargetResolution {
  const legacyAgent = typeof params.agent === 'string' ? params.agent.trim() : '';
  const rawBackendTarget = params.backendTarget ?? null;
  const backendTarget = resolveConcreteBackendTargetRefs(rawBackendTarget);

  if (!backendTarget) {
    if (rawBackendTarget !== null) {
      return { ok: false, errorMessage: 'Unknown agent id' };
    }
    if (!legacyAgent) {
      return { ok: false, errorMessage: 'agent or backendTarget is required' };
    }
    if (isLegacyCustomAcpId(legacyAgent)) {
      return { ok: false, errorMessage: 'backendTarget is required for customAcp' };
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
      providerHintAgentId: legacyAgent,
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
      providerHintAgentId: backendId,
    };
  }

  if (legacyAgent && !isLegacyCustomAcpId(legacyAgent)) {
    return { ok: false, errorMessage: 'agent must match backendTarget' };
  }

  return {
    ok: true,
    backendTargetV2: backendTarget.backendTargetV2,
    backendTarget: backendTarget.backendTarget,
    replayFlavor: `acp:${backendTarget.backendTargetV2.configuredBackendId ?? backendTarget.backendTargetV2.backendId}`,
    providerHintAgentId: 'customAcp',
  };
}
