import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1);

const legacyVendorSkillBackends = {
  codex_native: 'codex',
  opencode_native: 'opencode',
  claude_native: 'claude',
  pi_native: 'pi',
} as const;

const legacyHappierSkillOrigins = new Set(['happier_projected', 'text_fallback_only']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readLegacyVendorBackend(origin: string): string | null {
  return Object.prototype.hasOwnProperty.call(legacyVendorSkillBackends, origin)
    ? legacyVendorSkillBackends[origin as keyof typeof legacyVendorSkillBackends]
    : null;
}

/**
 * The canonical identity of a skill catalog item (D-23). `path` is deliberately NOT part of
 * it — a path is worktree- and machine-local, so embedding it in a persisted reference would
 * make the reference go stale (D-3/INV-9).
 */
function buildSkillCatalogItemId(input: Readonly<{
  backendId?: string | null;
  name: string;
  origin: SkillCatalogOriginV1;
  projectionRef?: string | null;
}>): string {
  return [
    input.origin,
    input.backendId ?? null,
    input.projectionRef ?? null,
    input.name,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(':');
}

/**
 * Folds a raw skill origin — canonical (`vendor` / `happier`) or legacy
 * per-backend (`codex_native`, `happier_projected`, …) — into the canonical
 * `(origin, backendId, projectionRef)` triple this schema stores. An
 * unrecognized origin yields an empty result, leaving the caller's own values
 * untouched.
 *
 * This is the ONLY declaration of the legacy origin table. It was previously
 * copied into the UI's composer catalog reader and its envelope writer; both
 * now consume this owner so a legacy payload and a current one can never
 * canonicalize differently on the read and write halves of one round trip.
 */
export function resolveSkillCatalogOriginV1(rawOrigin: string | null | undefined): Readonly<{
  origin?: SkillCatalogOriginV1;
  backendId?: string;
  projectionRef?: string;
}> {
  const origin = readString(rawOrigin);
  if (!origin) return {};
  if (origin === 'vendor' || origin === 'happier') return { origin };
  const legacyBackendId = readLegacyVendorBackend(origin);
  if (legacyBackendId) return { origin: 'vendor', backendId: legacyBackendId };
  if (legacyHappierSkillOrigins.has(origin)) return { origin: 'happier', projectionRef: origin };
  return {};
}

function normalizeSkillCatalogItemInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const name = readString(value.name);
  const rawOrigin = readString(value.origin);
  if (!name || !rawOrigin) return value;

  const legacy = resolveSkillCatalogOriginV1(rawOrigin);
  const canonicalOrigin = legacy.origin ?? null;
  if (!canonicalOrigin) return value;

  const backendId = readString(value.backendId) ?? legacy.backendId ?? null;
  const projectionRef = readString(value.projectionRef)
    ?? readString(value.projectionKind)
    ?? legacy.projectionRef
    ?? null;
  const id = readString(value.id) ?? buildSkillCatalogItemId({
    backendId,
    name,
    origin: canonicalOrigin,
    projectionRef,
  });

  return {
    ...value,
    v: 1,
    id,
    origin: canonicalOrigin,
    ...(backendId ? { backendId } : {}),
    ...(projectionRef ? { projectionRef } : {}),
  };
}

export type SkillCatalogItemIdentityV1 = Readonly<{
  id: string;
  origin: 'vendor' | 'happier';
  name: string;
  backendId: string | null;
  projectionRef: string | null;
}>;

/**
 * The identity a `happier.skill` reference points at, exposed so the send-time resolver and
 * the composer writer share ONE derivation instead of each inventing a key (EU-D0's
 * consolidation obligation). Returns `null` for an item carrying no usable identity: an
 * unidentifiable catalog item can never be the target of a reference.
 */
export function resolveSkillCatalogItemIdentityV1(value: unknown): SkillCatalogItemIdentityV1 | null {
  const normalized = normalizeSkillCatalogItemInput(value);
  if (!isRecord(normalized)) return null;
  const id = readString(normalized.id);
  const name = readString(normalized.name);
  const origin = readString(normalized.origin);
  if (!id || !name || (origin !== 'vendor' && origin !== 'happier')) return null;
  return {
    id,
    origin,
    name,
    backendId: readString(normalized.backendId),
    projectionRef: readString(normalized.projectionRef),
  };
}

export const SkillCatalogOriginV1Schema = z.enum(['vendor', 'happier']);
export type SkillCatalogOriginV1 = z.infer<typeof SkillCatalogOriginV1Schema>;

export const SkillCatalogItemV1Schema = z.preprocess(
  normalizeSkillCatalogItemInput,
  z
    .object({
      v: z.literal(1),
      id: NonEmptyStringSchema,
      origin: SkillCatalogOriginV1Schema,
      name: NonEmptyStringSchema,
      displayName: NonEmptyStringSchema.optional(),
      description: NonEmptyStringSchema.optional(),
      backendId: NonEmptyStringSchema.optional(),
      agentId: NonEmptyStringSchema.optional(),
      path: NonEmptyStringSchema.optional(),
      projectionRef: NonEmptyStringSchema.optional(),
      enabled: z.boolean().optional(),
      updatedAt: z.number().finite().optional(),
    })
    .passthrough(),
);
export type SkillCatalogItemV1 = z.output<typeof SkillCatalogItemV1Schema>;

export const SkillCatalogV1Schema = z
  .object({
    v: z.literal(1),
    backendId: NonEmptyStringSchema.optional(),
    agentId: NonEmptyStringSchema.optional(),
    updatedAt: z.number().finite(),
    items: z.array(SkillCatalogItemV1Schema).readonly(),
  })
  .passthrough();
export type SkillCatalogV1 = z.output<typeof SkillCatalogV1Schema>;
