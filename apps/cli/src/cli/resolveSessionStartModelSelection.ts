import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { BackendTargetRefV2InputSchema, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveSessionModelSelectionInputRefV1, SessionModelSelectionResolutionError, SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionModelSelectionSchema, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

/** Keeps startup target selection shared by model ingress and runtime admission. */
export function resolveSessionStartBackendTarget(params: Readonly<{
  agentTarget?: AgentExecutionTargetV1;
  backendTarget?: BackendTargetRefV2Input;
  backendId: string;
}>): BackendTargetRefV2Input {
  return params.agentTarget ?? params.backendTarget ?? {
    kind: 'backend',
    backendId: params.backendId,
    sourceKind: 'built_in',
  };
}

/** Canonicalizes the CLI child-process ingress before the host runtime sees it. */
export function resolveSessionStartModelSelection(params: Readonly<{
  backendTarget: unknown;
  canonicalSelection?: SessionModelSelection;
  fallbackSelection?: SessionModelSelection;
  legacyModelId?: string;
  providerConnectionId?: string;
  legacyModelUpdatedAt?: number;
  nowMs?: number;
}>): SessionModelSelection | undefined {
  const legacyModelId = params.legacyModelId;
  if (!params.canonicalSelection && typeof legacyModelId !== 'string' && !params.fallbackSelection) return undefined;
  const agentTargetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(
    BackendTargetRefV2InputSchema.parse(params.backendTarget),
  ));
  if (params.canonicalSelection) {
    const selection = SessionModelSelectionSchema.parse(params.canonicalSelection);
    if (selection.ref.agentTargetKey !== agentTargetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
    }
    return selection;
  }
  if (typeof legacyModelId !== 'string') {
    const selection = SessionModelSelectionSchema.parse(params.fallbackSelection);
    if (selection.ref.agentTargetKey !== agentTargetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
    }
    return selection;
  }

  const ref = resolveSessionModelSelectionInputRefV1({
    agentTargetKey,
    providerConnectionId: params.providerConnectionId ?? null,
    modelId: legacyModelId,
  });
  if (ref === null) return undefined;
  return SessionModelSelectionV1Schema.parse({
    v: 1,
    updatedAt: typeof params.legacyModelUpdatedAt === 'number'
      ? params.legacyModelUpdatedAt
      : params.nowMs ?? Date.now(),
    ref,
  });
}
