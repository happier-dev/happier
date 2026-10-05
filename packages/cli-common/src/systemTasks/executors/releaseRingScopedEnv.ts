import { resolvePublicReleaseRingLabelForId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS } from '../../firstPartyRuntime/resolveManagedCliReleaseChannel.js';

export function applyPublicReleaseRingScopeToEnv(
  env: NodeJS.ProcessEnv,
  ring: PublicReleaseRingId | null | undefined,
): NodeJS.ProcessEnv {
  if (ring == null) return env;

  const label = resolvePublicReleaseRingLabelForId(ring);
  const next: NodeJS.ProcessEnv = { ...env };

  for (const key of STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS) delete next[key];
  next.HAPPIER_PUBLIC_RELEASE_CHANNEL = label;
  next.HAPPIER_RELEASE_RING = label;

  return next;
}
