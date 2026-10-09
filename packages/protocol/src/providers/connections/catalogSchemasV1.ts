import { ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema, type ProviderDefaultModelSelectionsByAgentTargetKeyV1 } from '../selection/v1.js';
import { type ProviderSettingsV1 } from '../settings/v1.js';
import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ProviderSettingsV1BaseSchema, isCanonicalProviderSavedSecretIdV1, refineProviderSettingsV1 } from '../settings/v1.js';


/** One catalog owns the incumbent Provider rules; no second entry validator. */
export const ProviderConnectionsCatalogV1Schema = lazyZodSchema(() => ProviderSettingsV1BaseSchema.omit({ defaultsByAgentTargetKey: true })
  .superRefine((catalog, context) => refineProviderSettingsV1({ ...catalog, defaultsByAgentTargetKey: {} }, context)));
export type ProviderConnectionsCatalogV1 = z.infer<typeof ProviderConnectionsCatalogV1Schema>;
export const StoredProviderConnectionsCatalogV1Schema = createStoredReadSchema(ProviderConnectionsCatalogV1Schema);

export const ProviderConnectionsContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: ProviderConnectionsCatalogV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type ProviderConnectionsContentV1 = z.infer<typeof ProviderConnectionsContentV1Schema>;

function admitProviderCatalogJson(value: unknown, context: z.core.$RefinementCtx) {
  const parsed = StrictJsonValueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) context.addIssue(issue);
  return z.NEVER;
}

/** Keep the original body until the domain opener has checked the complete inventory. */
export const StoredProviderConnectionsContentV1Schema = lazyZodSchema(() => z.preprocess(admitProviderCatalogJson, z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: PluginJsonValueV2Schema }).catchall(PluginJsonValueV2Schema),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).catchall(PluginJsonValueV2Schema),
])));
export type StoredProviderConnectionsContentV1 = z.infer<typeof StoredProviderConnectionsContentV1Schema>;

/** Conversion preserves the original stored body after complete domain admission. */
export const ProviderConnectionsMigrationContentV1Schema = StoredProviderConnectionsContentV1Schema;
export type ProviderConnectionsMigrationContentV1 = z.infer<typeof ProviderConnectionsMigrationContentV1Schema>;

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const ProviderConnectionsRowFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']), reason: z.string().optional(),
}).strict());
export const ProviderConnectionsRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision, content: StoredProviderConnectionsContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(), z.object({ status: z.literal('deleted'), revision }).strict(), ProviderConnectionsRowFailureV1Schema,
]));
export const ProviderConnectionsRowMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([revision, z.literal('absent')]), content: ProviderConnectionsContentV1Schema.nullable(), sourceSettingsVersion: revision.optional(),
  referencedSavedSecretIds: z.array(z.string().refine(isCanonicalProviderSavedSecretIdV1, 'SavedSecret reference must be canonical')),
  savedSecretRevisions: z.array(z.object({ resourceId: z.string().min(1), expectedRevision: revision }).strict()),
}).strict().superRefine((mutation, context) => {
  if (new Set(mutation.referencedSavedSecretIds).size !== mutation.referencedSavedSecretIds.length
    || new Set(mutation.savedSecretRevisions.map(item => item.resourceId)).size !== mutation.savedSecretRevisions.length) {
    context.addIssue({ code: 'custom', message: 'SavedSecret captures must be unique' });
  }
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First catalog initialization requires captured source currentness' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source currentness initializes catalog authority only' });
  }
}));
export type ProviderConnectionsRowMutationV1 = z.infer<typeof ProviderConnectionsRowMutationV1Schema>;
export const ProviderConnectionsRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision, cursor: revision }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(), ProviderConnectionsRowFailureV1Schema,
  z.object({ status: z.literal('settings-conflict'), revision }).strict(),
  z.object({ status: z.literal('invalid-reference') }).strict(),
]));

export type ProviderConnectionsCatalogSnapshotV1 =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'partial'; revision: number | 'absent'; catalog: ProviderConnectionsCatalogV1; diagnostics: readonly Readonly<{ path: string; reason: string }>[] }>
  | Readonly<{ status: 'ready'; revision: number | 'absent'; catalog: ProviderConnectionsCatalogV1;
      cleanup?: Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; reason: string }> }>;

/** HTTP admission failures are logical read outcomes, not new server row wire shapes. */
export type ProviderConnectionsCatalogRowReadResultV1 = z.infer<typeof ProviderConnectionsRowReadResponseV1Schema>
  | Extract<ProviderConnectionsCatalogSnapshotV1, { status: 'unavailable' }>;

export function splitProviderSettingsV1(settings: ProviderSettingsV1): Readonly<{
  catalog: ProviderConnectionsCatalogV1; defaults: ProviderDefaultModelSelectionsByAgentTargetKeyV1;
}> {
  const { defaultsByAgentTargetKey, ...catalog } = settings;
  return { catalog: ProviderConnectionsCatalogV1Schema.parse(catalog),
    defaults: ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.parse(defaultsByAgentTargetKey) };
}

export function composeProviderSettingsV1(catalog: ProviderConnectionsCatalogV1,
  defaults: ProviderDefaultModelSelectionsByAgentTargetKeyV1): ProviderSettingsV1 {
  // A missing contribution does not erase selected intent. The preference has its own schema.
  return { ...ProviderConnectionsCatalogV1Schema.parse(catalog), defaultsByAgentTargetKey: ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.parse(defaults) };
}
