import { resolvePublicReleaseRingLabelForId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

function isMissingEnvValue(value: unknown): boolean {
  return !String(value ?? '').trim();
}

export function applyPublicReleaseRingScopeToEnv(
  env: NodeJS.ProcessEnv,
  ring: PublicReleaseRingId | null | undefined,
): NodeJS.ProcessEnv {
  const ringId: PublicReleaseRingId = ring ?? 'stable';
  if (ringId === 'stable') return env;

  const label = resolvePublicReleaseRingLabelForId(ringId);
  const next: NodeJS.ProcessEnv = { ...env };

  if (isMissingEnvValue(env.HAPPIER_PUBLIC_RELEASE_CHANNEL)) {
    next.HAPPIER_PUBLIC_RELEASE_CHANNEL = label;
  }
  if (isMissingEnvValue(env.HAPPIER_RELEASE_RING)) {
    next.HAPPIER_RELEASE_RING = label;
  }

  return next;
}
