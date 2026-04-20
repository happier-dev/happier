import { z } from 'zod';

const EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS = 'EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS';

// IMPORTANT: Expo only inlines EXPO_PUBLIC_* variables when accessed via dot notation.
// Avoid dynamic process.env[key] reads in production code paths.
const STATIC_HAPPIER_MODEL_PACK_MANIFESTS = process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS;

const DEFAULT_HAPPIER_ASSETS_OWNER_REPO = 'happier-dev/happier-assets';
const DEFAULT_HAPPIER_ASSETS_RELEASE_TAG = 'model-packs';

const ManifestMapSchema = z.record(z.string().min(1), z.string().url());

function readManifestMap(raw: string | undefined): Record<string, string> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = ManifestMapSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function resolveModelPackManifestUrl(opts: {
  packId: string | null;
  env?: Record<string, string | undefined>;
}): string | null {
  const env = opts.env ?? null;
  const id = opts.packId && opts.packId.trim().length > 0 ? opts.packId.trim() : 'default';

  const map = readManifestMap(env ? env[EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS] : STATIC_HAPPIER_MODEL_PACK_MANIFESTS);
  const fromMap = map?.[id];
  if (typeof fromMap === 'string' && fromMap.trim().length > 0) return fromMap.trim();

  // Default to our published assets repository so model packs work out-of-the-box.
  return `https://github.com/${DEFAULT_HAPPIER_ASSETS_OWNER_REPO}/releases/download/${DEFAULT_HAPPIER_ASSETS_RELEASE_TAG}/${encodeURIComponent(
    id,
  )}__manifest.json`;
}
