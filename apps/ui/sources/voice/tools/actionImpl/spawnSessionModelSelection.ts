import {
  createProviderErrorV1,
  SessionModelSelectionV1Schema,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  resolveSessionModelSelectionInputRefV1,
  type BackendTargetRefV2,
  type ProviderErrorV1,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveRuntimeFeatureDecision } from '@/sync/domains/features/featureDecisionInputs';

import { normalizeNonEmptyString } from './shared';

export type VoiceProviderFeatureGateResult =
  | Readonly<{ ok: true; providerConnectionId: string | null }>
  | Readonly<{
    ok: false;
    type: 'error';
    errorCode: 'provider_feature_disabled';
    errorMessage: 'provider_feature_disabled';
    errorDetail: Readonly<{
      kind: typeof SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR;
      providerError: ProviderErrorV1;
    }>;
  }>;

export async function isVoiceProvidersFeatureEnabledForSpawn(params: Readonly<{
  serverId?: string | null;
}>): Promise<boolean> {
  const serverId = normalizeNonEmptyString(params.serverId);
  const decision = await resolveRuntimeFeatureDecision({
    featureId: 'providers',
    scope: {
      scopeKind: 'spawn',
      serverId,
    },
  });
  return decision.state === 'enabled';
}

export async function resolveVoiceProviderFeatureGate(params: Readonly<{
  providerConnectionId?: string | null;
  machineId?: string | null;
  serverId?: string | null;
}>): Promise<VoiceProviderFeatureGateResult> {
  const providerConnectionId = normalizeNonEmptyString(params.providerConnectionId);
  if (!providerConnectionId) {
    return { ok: true, providerConnectionId: null };
  }

  if (await isVoiceProvidersFeatureEnabledForSpawn({ serverId: params.serverId })) {
    return { ok: true, providerConnectionId };
  }

  const machineId = normalizeNonEmptyString(params.machineId);
  const providerError = createProviderErrorV1('provider_feature_disabled', {
    connectionId: providerConnectionId,
    ...(machineId ? { machineId } : {}),
  });
  return {
    ok: false,
    type: 'error',
    errorCode: 'provider_feature_disabled',
    errorMessage: 'provider_feature_disabled',
    errorDetail: {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR,
      providerError,
    },
  };
}

export function resolveVoiceSpawnModelSelection(params: Readonly<{
  backendTarget: BackendTargetRefV2;
  modelId?: string | null;
  providerConnectionId?: string | null;
  updatedAt?: number;
}>): SessionModelSelectionV1 | null {
  const modelId = normalizeNonEmptyString(params.modelId);
  const providerConnectionId = normalizeNonEmptyString(params.providerConnectionId);
  if (!modelId) {
    if (providerConnectionId) {
      throw new Error('providerConnectionId requires an explicit modelId');
    }
    return null;
  }

  const ref = resolveSessionModelSelectionInputRefV1({
    agentTargetKey: resolveBackendTargetKeyV2(params.backendTarget),
    providerConnectionId,
    modelId,
  });
  if (!ref) return null;

  return SessionModelSelectionV1Schema.parse({
    v: 1,
    ref,
    updatedAt: params.updatedAt ?? Date.now(),
  });
}
