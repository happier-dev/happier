/**
 * Canonical model-pack manifest-URL resolver.
 *
 * One owner for "given a pack id (and optional host-supplied manifest map),
 * which https URL serves its `pack.json`?" Both the UI native installer and the
 * daemon resolve THROUGH this so there is a single source of truth — no
 * host-specific URL rewriting.
 *
 * File URLs inside a resolved manifest are trusted as-authored (and gated by the
 * shared URL policy + integrity gate); the previous native-only GitHub
 * file-URL rewrite is removed.
 */

const DEFAULT_MANIFEST_BASE = 'https://github.com/happier-dev/happier-assets/releases/download/model-packs';

/**
 * Default published manifest URL for a pack id. The pack id is expected to be
 * filesystem-safe already (callers validate via protocol `pathSafety`).
 */
export function defaultModelPackManifestUrl(packId: string): string {
  return `${DEFAULT_MANIFEST_BASE}/${encodeURIComponent(packId)}__manifest.json`;
}

function parseManifestMap(raw: string | null | undefined): Record<string, string> | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Resolve the manifest URL for a pack id, consulting (in order) any explicit
 * override, a host-supplied JSON manifest map (e.g. from
 * `HAPPIER_MODEL_PACK_MANIFESTS`), and finally the default published URL.
 */
export function resolveModelPackManifestUrl(opts: {
  packId: string;
  /** Explicit per-call override (wins when a non-empty string). */
  overrideUrl?: string | null;
  /** Raw JSON map string of `{ [packId]: manifestUrl }`. */
  manifestMapRaw?: string | null;
}): string {
  const override = opts.overrideUrl?.trim();
  if (override) {
    return override;
  }
  const map = parseManifestMap(opts.manifestMapRaw);
  const fromMap = map?.[opts.packId];
  if (typeof fromMap === 'string' && fromMap.trim().length > 0) {
    return fromMap.trim();
  }
  return defaultModelPackManifestUrl(opts.packId);
}
