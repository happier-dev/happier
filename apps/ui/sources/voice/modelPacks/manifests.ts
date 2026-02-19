import { z } from 'zod';

const EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS = 'EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS';

// Legacy Kokoro-only env keys (supported temporarily for backward compatibility).
const EXPO_PUBLIC_KOKORO_NATIVE_MANIFEST_URL = 'EXPO_PUBLIC_KOKORO_NATIVE_MANIFEST_URL';
const EXPO_PUBLIC_KOKORO_NATIVE_MANIFESTS = 'EXPO_PUBLIC_KOKORO_NATIVE_MANIFESTS';

// IMPORTANT: Expo only inlines EXPO_PUBLIC_* variables when accessed via dot notation.
// Avoid dynamic process.env[key] reads in production code paths.
const STATIC_HAPPIER_MODEL_PACK_MANIFESTS = process.env.EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS;
const STATIC_KOKORO_NATIVE_MANIFESTS = process.env.EXPO_PUBLIC_KOKORO_NATIVE_MANIFESTS;
const STATIC_KOKORO_NATIVE_MANIFEST_URL = process.env.EXPO_PUBLIC_KOKORO_NATIVE_MANIFEST_URL;

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

  const legacyMap = readManifestMap(env ? env[EXPO_PUBLIC_KOKORO_NATIVE_MANIFESTS] : STATIC_KOKORO_NATIVE_MANIFESTS);
  const fromLegacyMap = legacyMap?.[id];
  if (typeof fromLegacyMap === 'string' && fromLegacyMap.trim().length > 0) return fromLegacyMap.trim();

  const fromLegacyDefault = env ? env[EXPO_PUBLIC_KOKORO_NATIVE_MANIFEST_URL] : STATIC_KOKORO_NATIVE_MANIFEST_URL;
  if (typeof fromLegacyDefault === 'string' && fromLegacyDefault.trim().length > 0) return fromLegacyDefault.trim();

  // Default to our published assets repository so model packs work out-of-the-box.
  return `https://github.com/${DEFAULT_HAPPIER_ASSETS_OWNER_REPO}/releases/download/${DEFAULT_HAPPIER_ASSETS_RELEASE_TAG}/${encodeURIComponent(
    id,
  )}__manifest.json`;
}
