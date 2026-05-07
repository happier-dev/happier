import { configuration } from '@/configuration';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { resolveCliGlobalOnlyFeatureDecision } from '@/features/featureDecisionGlobalOnly';
import type { FeatureId } from '@happier-dev/protocol';

const PET_COMPANION_FEATURE_GATE_TIMEOUT_MS = 800;
const PET_COMPANION_FEATURE_GATE_CACHE_TTL_MS = 5_000;

type PetCompanionFeatureGateCache = Readonly<{
  resolvedAtMs: number;
  enabled: boolean;
}>;

type PetServerFeatureId = Extract<FeatureId, 'pets.companion' | 'pets.sync'>;

export function isPetCompanionFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCliGlobalOnlyFeatureDecision({
    featureId: 'pets.companion',
    env,
  }).state === 'enabled';
}

async function resolvePetServerFeatureEnabled(
  featureId: PetServerFeatureId,
  params: Readonly<{
    env?: NodeJS.ProcessEnv;
    serverUrl?: string;
    timeoutMs?: number;
  }> = {},
): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId,
    env: params.env ?? process.env,
    serverUrl: params.serverUrl ?? configuration.apiServerUrl,
    timeoutMs: params.timeoutMs ?? PET_COMPANION_FEATURE_GATE_TIMEOUT_MS,
  });
  return resolved.decision.state === 'enabled';
}

export async function resolvePetCompanionFeatureEnabled(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
}> = {}): Promise<boolean> {
  return resolvePetServerFeatureEnabled('pets.companion', params);
}

export async function resolvePetSyncFeatureEnabled(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
}> = {}): Promise<boolean> {
  return resolvePetServerFeatureEnabled('pets.sync', params);
}

function createPetServerFeatureGateResolver(
  featureId: PetServerFeatureId,
  params: Readonly<{
    env?: NodeJS.ProcessEnv;
    serverUrl?: string;
    timeoutMs?: number;
    cacheTtlMs?: number;
    nowMs?: () => number;
  }> = {},
): () => Promise<boolean> {
  let cache: PetCompanionFeatureGateCache | null = null;
  const cacheTtlMs = params.cacheTtlMs ?? PET_COMPANION_FEATURE_GATE_CACHE_TTL_MS;
  const nowMs = params.nowMs ?? Date.now;

  return async () => {
    const now = nowMs();
    if (cache && now - cache.resolvedAtMs < cacheTtlMs) {
      return cache.enabled;
    }

    const enabled = await resolvePetServerFeatureEnabled(featureId, {
      env: params.env,
      serverUrl: params.serverUrl,
      timeoutMs: params.timeoutMs,
    });
    cache = { resolvedAtMs: now, enabled };
    return enabled;
  };
}

export function createPetCompanionFeatureGateResolver(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  nowMs?: () => number;
}> = {}): () => Promise<boolean> {
  return createPetServerFeatureGateResolver('pets.companion', params);
}

export function createPetSyncFeatureGateResolver(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  nowMs?: () => number;
}> = {}): () => Promise<boolean> {
  return createPetServerFeatureGateResolver('pets.sync', params);
}
