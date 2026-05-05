import {
  DaemonPetForgetLocalPackageRequestV1Schema,
  type DaemonPetForgetLocalPackageResponseV1,
} from '@happier-dev/protocol';

import type { PetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';
import { forgetManagedLocalPetSource } from '../storage/managedLocalPetRegistry';
import type { PetRpcRateLimiter } from './petRpcRateLimiter';

type ForgetLocalPetPackageDeps = Readonly<{
  discoveryCache?: PetPackageDiscoveryCache;
  managedRoot?: string;
  companionFeatureEnabled?: boolean;
  rateLimiter?: PetRpcRateLimiter;
}>;

export async function handleForgetLocalPetPackage(
  raw: unknown,
  deps: ForgetLocalPetPackageDeps = {},
): Promise<DaemonPetForgetLocalPackageResponseV1> {
  if (deps.companionFeatureEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.companion is disabled.' };
  }
  if (deps.rateLimiter?.tryConsume('forgetLocalPackage') === false) {
    return { ok: false, errorCode: 'rate_limited', error: 'Pet removal is rate limited.' };
  }

  const parsed = DaemonPetForgetLocalPackageRequestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }

  const forgotten = await forgetManagedLocalPetSource({
    sourceKey: parsed.data.sourceKey,
    managedRoot: deps.managedRoot,
  });
  if (!forgotten.ok) return forgotten;

  deps.discoveryCache?.forget(parsed.data.sourceKey);
  return forgotten;
}
