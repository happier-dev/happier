import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasConnectedServiceBinding(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.v !== 1) return false;
  if (!isRecord(payload.bindingsByServiceId)) return false;

  for (const binding of Object.values(payload.bindingsByServiceId)) {
    if (!isRecord(binding)) continue;
    if (binding.source !== 'connected') continue;
    const profileId = binding.profileId;
    if (typeof profileId === 'string' && profileId.trim().length > 0) return true;
    // Treat "connected" with no explicit profile as a connected-services request;
    // selection defaults may be applied later in the UI/client.
    return true;
  }

  return false;
}

export function shouldResolveConnectedServiceAuthForSpawn(options: SpawnSessionOptions): boolean {
  if (typeof options.token === 'string' && options.token.trim().length > 0) return false;
  return hasConnectedServiceBinding(options.connectedServices);
}
