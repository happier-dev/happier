import {
  buildBackendTargetKeyV2,
  BackendTargetRefV2InputSchema,
  readBackendTargetRefV2,
  resolveSessionModelSelectionInputRefV1,
  SessionModelSelectionResolutionError,
  SessionModelSelectionV1Schema,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';

/** Canonicalizes the CLI child-process ingress before the host runtime sees it. */
export function resolveSessionStartModelSelection(params: Readonly<{
  backendTarget: unknown;
  canonicalSelection?: SessionModelSelectionV1;
  fallbackSelection?: SessionModelSelectionV1;
  legacyModelId?: string;
  providerConnectionId?: string;
  legacyModelUpdatedAt?: number;
  nowMs?: number;
}>): SessionModelSelectionV1 | undefined {
  const legacyModelId = params.legacyModelId;
  if (!params.canonicalSelection && typeof legacyModelId !== 'string' && !params.fallbackSelection) return undefined;
  const agentTargetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(
    BackendTargetRefV2InputSchema.parse(params.backendTarget),
  ));
  if (params.canonicalSelection) {
    const selection = SessionModelSelectionV1Schema.parse(params.canonicalSelection);
    if (selection.ref.agentTargetKey !== agentTargetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
    }
    return selection;
  }
  if (typeof legacyModelId !== 'string') {
    const selection = SessionModelSelectionV1Schema.parse(params.fallbackSelection);
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
