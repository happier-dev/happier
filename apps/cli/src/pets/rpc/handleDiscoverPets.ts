import {
  DaemonPetDiscoverRequestV1Schema,
  type DaemonPetDiscoverResponseV1,
} from '@happier-dev/protocol';

import { discoverCodexPets } from '../discovery/discoverCodexPets';
import { createPetSourceKey } from '../discovery/createPetSourceKey';
import type { PetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';
import { type PetDiscoveryRoot, resolveCodexPetRootsWithDiagnostics } from '../discovery/resolveCodexPetRoots';
import { resolveManagedPetRoot } from '../storage/resolveManagedPetRoot';
import { toDiscoveredPetPackageDto } from './petSourceDto';
import type { PetRpcRateLimiter } from './petRpcRateLimiter';

export async function handleDiscoverPets(
  raw: unknown,
  deps: Readonly<{
    env?: NodeJS.ProcessEnv;
    activeServerDir?: string;
    happyHomeDir?: string;
    discoveryCache?: PetPackageDiscoveryCache;
    companionFeatureEnabled?: boolean;
    rateLimiter?: PetRpcRateLimiter;
  }> = {},
): Promise<DaemonPetDiscoverResponseV1> {
  if (deps.companionFeatureEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.companion is disabled.' };
  }
  if (deps.rateLimiter?.tryConsume('discoverPackages') === false) {
    return { ok: false, errorCode: 'rate_limited', error: 'Pet discovery is rate limited.' };
  }

  const parsed = DaemonPetDiscoverRequestV1Schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }

  const resolvedRoots = await resolveCodexPetRootsWithDiagnostics({
    env: deps.env,
    activeServerDir: deps.activeServerDir,
    includeUserCodexHome: parsed.data.includeDetectedCodexHomes === false ? false : parsed.data.includeUserCodexHome,
    includeConnectedServiceCodexHomes: parsed.data.includeDetectedCodexHomes === false ? false : parsed.data.includeConnectedServiceCodexHomes,
    maxConnectedServiceRoots: parsed.data.maxRoots,
  });

  const roots: PetDiscoveryRoot[] = [...resolvedRoots.roots];
  if (parsed.data.includeManagedLocal !== false) {
    const petsPath = resolveManagedPetRoot(deps.happyHomeDir);
    roots.push({
      kind: 'happierManagedLocal',
      petsPath,
      sourceKey: createPetSourceKey(['happierManagedLocalRoot', petsPath]),
    });
  }

  const discovered = await discoverCodexPets({
    roots,
    maxPetsPerRoot: parsed.data.maxPetsPerRoot,
    maxDiscoveryWallClockMs: parsed.data.maxDiscoveryWallClockMs,
  });
  deps.discoveryCache?.drop();
  deps.discoveryCache?.remember(discovered.pets);
  return {
    ok: true,
    pets: discovered.pets.map(toDiscoveredPetPackageDto),
    diagnostics: [...resolvedRoots.diagnostics, ...discovered.diagnostics].map((item) => ({
      code: item.code,
      message: item.message,
    })),
    partial: resolvedRoots.partial || discovered.partial,
  };
}
