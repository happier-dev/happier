import { readServerEnabledBit } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { resolveCliGlobalOnlyFeatureDecision } from '@/features/featureDecisionGlobalOnly';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

const PET_COMPANION_FEATURE_ID = 'pets.companion';
const PET_COMPANION_FEATURE_GATE_TIMEOUT_MS = 800;
const PET_COMPANION_FEATURE_GATE_CACHE_TTL_MS = 5_000;

type PetCompanionFeatureGateCache = Readonly<{
  resolvedAtMs: number;
  enabled: boolean;
}>;

export function isPetCompanionFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCliGlobalOnlyFeatureDecision({
    featureId: PET_COMPANION_FEATURE_ID,
    env,
  }).state === 'enabled';
}

export async function resolvePetCompanionFeatureEnabled(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
}> = {}): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: PET_COMPANION_FEATURE_ID,
    env: params.env ?? process.env,
    serverUrl: params.serverUrl ?? configuration.apiServerUrl,
    timeoutMs: params.timeoutMs ?? PET_COMPANION_FEATURE_GATE_TIMEOUT_MS,
  });
  if (resolved.serverSnapshot) {
    return resolved.decision.state === 'enabled';
  }
  if (resolved.decision.state !== 'enabled') {
    return false;
  }

  const serverSnapshot = await fetchServerFeaturesSnapshot({
    serverUrl: params.serverUrl ?? configuration.apiServerUrl,
    timeoutMs: params.timeoutMs ?? PET_COMPANION_FEATURE_GATE_TIMEOUT_MS,
  });
  if (serverSnapshot.status !== 'ready') {
    return false;
  }
  return readServerEnabledBit(serverSnapshot.features, PET_COMPANION_FEATURE_ID) === true;
}

export function createPetCompanionFeatureGateResolver(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  nowMs?: () => number;
}> = {}): () => Promise<boolean> {
  let cache: PetCompanionFeatureGateCache | null = null;
  const cacheTtlMs = params.cacheTtlMs ?? PET_COMPANION_FEATURE_GATE_CACHE_TTL_MS;
  const nowMs = params.nowMs ?? Date.now;

  return async () => {
    const now = nowMs();
    if (cache && now - cache.resolvedAtMs < cacheTtlMs) {
      return cache.enabled;
    }

    const enabled = await resolvePetCompanionFeatureEnabled({
      env: params.env,
      serverUrl: params.serverUrl,
      timeoutMs: params.timeoutMs,
    });
    cache = { resolvedAtMs: now, enabled };
    return enabled;
  };
}
