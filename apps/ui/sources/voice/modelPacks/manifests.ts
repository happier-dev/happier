import { resolveModelPackManifestUrl as resolveSharedModelPackManifestUrl } from '@happier-dev/voice-modelpacks';

const EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS = 'EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS';

// IMPORTANT: Expo only inlines EXPO_PUBLIC_* variables when accessed via dot notation.
// Avoid dynamic process.env[key] reads in production code paths.
const STATIC_HAPPIER_MODEL_PACK_MANIFESTS = process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS;

export function resolveModelPackManifestUrl(opts: {
  packId: string | null;
  env?: Record<string, string | undefined>;
}): string | null {
  const env = opts.env ?? null;
  const id = opts.packId && opts.packId.trim().length > 0 ? opts.packId.trim() : 'default';
  return resolveSharedModelPackManifestUrl({
    packId: id,
    manifestMapRaw: env ? env[EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS] : STATIC_HAPPIER_MODEL_PACK_MANIFESTS,
  });
}
