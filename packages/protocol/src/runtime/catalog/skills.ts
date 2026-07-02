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

function normalizeSkillCatalogItemInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const name = readString(value.name);
  const rawOrigin = readString(value.origin);
  if (!name || !rawOrigin) return value;

  const legacyBackendId = readLegacyVendorBackend(rawOrigin);
  const canonicalOrigin = rawOrigin === 'vendor' || rawOrigin === 'happier'
    ? rawOrigin
    : legacyBackendId
      ? 'vendor'
      : legacyHappierSkillOrigins.has(rawOrigin)
        ? 'happier'
        : null;
  if (!canonicalOrigin) return value;

  const backendId = readString(value.backendId) ?? legacyBackendId;
  const projectionRef = readString(value.projectionRef)
    ?? readString(value.projectionKind)
    ?? (canonicalOrigin === 'happier' && rawOrigin !== 'happier' ? rawOrigin : null);
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
