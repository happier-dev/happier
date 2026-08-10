/**
 * The canonical identity of a skill catalog item (D-23, derived in EU-D0).
 *
 * A skill is identified by the tuple `(origin, backendId, projectionRef, name)`, materialized
 * as one string. `path` is deliberately NOT part of it: a path is worktree- and machine-local,
 * so embedding it in a persisted reference would make the reference go stale (D-3/INV-9).
 *
 * This is a byte-for-byte port of `../dev`'s
 * `packages/protocol/src/runtime/catalog/skills.ts` derivation, including its legacy-origin
 * folding. The two repositories must agree exactly: a `happier.skill` reference is persisted
 * and transmitted, so a reference written by one repository is resolved by the other.
 */

const LEGACY_VENDOR_SKILL_BACKENDS = {
  codex_native: 'codex',
  opencode_native: 'opencode',
  claude_native: 'claude',
  pi_native: 'pi',
} as const;

const LEGACY_HAPPIER_SKILL_ORIGINS = ['happier_projected', 'text_fallback_only'] as const;

/**
 * The legacy origin vocabulary, declared ONCE. The catalog wire schema derives its legacy
 * arm from this list (`sessionWorkStateRpc.ts`) instead of re-listing the literals, so an
 * origin the schema accepts is always one this module can fold to a canonical identity.
 */
export const LEGACY_SKILL_CATALOG_ORIGINS_V1 = [
  ...Object.keys(LEGACY_VENDOR_SKILL_BACKENDS),
  ...LEGACY_HAPPIER_SKILL_ORIGINS,
] as readonly string[] as readonly [string, ...string[]];

export type SkillCatalogOriginV1 = 'vendor' | 'happier';

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readLegacyVendorBackend(origin: string): string | null {
  return Object.prototype.hasOwnProperty.call(LEGACY_VENDOR_SKILL_BACKENDS, origin)
    ? LEGACY_VENDOR_SKILL_BACKENDS[origin as keyof typeof LEGACY_VENDOR_SKILL_BACKENDS]
    : null;
}

export type SkillCatalogItemIdentityV1 = Readonly<{
  id: string;
  origin: SkillCatalogOriginV1;
  name: string;
  backendId: string | null;
  projectionRef: string | null;
}>;

/**
 * Returns `null` when the item carries no usable identity — a missing name, a missing origin,
 * or an origin outside the canonical and legacy sets. An unidentifiable catalog item can never
 * be the target of a reference, so it is skipped rather than guessed at.
 */
export function resolveSkillCatalogItemIdentityV1(value: unknown): SkillCatalogItemIdentityV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;

  const name = readString(item.name);
  const rawOrigin = readString(item.origin);
  if (!name || !rawOrigin) return null;

  const legacyBackendId = readLegacyVendorBackend(rawOrigin);
  const origin: SkillCatalogOriginV1 | null = rawOrigin === 'vendor' || rawOrigin === 'happier'
    ? rawOrigin
    : legacyBackendId
      ? 'vendor'
      : (LEGACY_HAPPIER_SKILL_ORIGINS as readonly string[]).includes(rawOrigin)
        ? 'happier'
        : null;
  if (!origin) return null;

  const backendId = readString(item.backendId) ?? legacyBackendId;
  const projectionRef = readString(item.projectionRef)
    ?? readString(item.projectionKind)
    ?? (origin === 'happier' && rawOrigin !== 'happier' ? rawOrigin : null);

  const id = readString(item.id)
    ?? [origin, backendId, projectionRef, name]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(':');

  return { id, origin, name, backendId, projectionRef };
}
