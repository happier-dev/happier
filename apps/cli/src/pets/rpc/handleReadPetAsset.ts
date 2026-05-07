import {
  DaemonPetReadPreviewAssetRequestV1Schema,
  type DaemonPetReadPreviewAssetResponseV1,
} from '@happier-dev/protocol';

import type { PetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';
import { resolveManagedLocalPetSourceBySourceKey } from '../storage/managedLocalPetRegistry';
import { readPetAsset } from '../storage/readPetAsset';
import type { PetRpcRateLimiter } from './petRpcRateLimiter';

export async function handleReadPetPreviewAsset(
  raw: unknown,
  deps: Readonly<{
    discoveryCache?: PetPackageDiscoveryCache;
    managedRoot?: string;
    companionFeatureEnabled?: boolean;
    rateLimiter?: PetRpcRateLimiter;
  }> = {},
): Promise<DaemonPetReadPreviewAssetResponseV1> {
  if (deps.companionFeatureEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.companion is disabled.' };
  }
  if (deps.rateLimiter?.tryConsume('readPreviewAsset') === false) {
    return { ok: false, errorCode: 'rate_limited', error: 'Pet preview is rate limited.' };
  }

  const parsed = DaemonPetReadPreviewAssetRequestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }

  // Trust boundary: preview access is sourceKey registry based, never caller-supplied paths.
  const cachedSource = deps.discoveryCache?.get(parsed.data.sourceKey)?.source ?? null;
  let source = cachedSource;
  if (!source) {
    const managedLocalSource = await resolveManagedLocalPetSourceBySourceKey({
      sourceKey: parsed.data.sourceKey,
      managedRoot: deps.managedRoot,
    });
    if (managedLocalSource.ok) {
      source = managedLocalSource.source;
    } else if (managedLocalSource.errorCode !== 'not_found') {
      return {
        ok: false,
        errorCode: managedLocalSource.errorCode,
        error: managedLocalSource.error,
      };
    }
  }
  if (!source) {
    return { ok: false, errorCode: 'not_found', error: 'Pet package source was not found.' };
  }

  const result = await readPetAsset({
    source,
    maxBytes: parsed.data.maxBytes,
  });
  if (!result.ok) return result;

  return {
    sourceKey: parsed.data.sourceKey,
    mediaType: result.mediaType,
    digest: result.digest,
    dataBase64: result.data,
    sizeBytes: result.sizeBytes,
  };
}
