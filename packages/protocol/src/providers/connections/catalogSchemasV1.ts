import { ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema, type ProviderDefaultModelSelectionsByAgentTargetKeyV1 } from '../selection/v1.js';
import type { ProviderSettingsV1 } from '../settings/v1.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ProviderSettingsV1BaseSchema, isCanonicalProviderSavedSecretIdV1, refineProviderSettingsV1 } from '../settings/v1.js';


/** One catalog owns the incumbent Provider rules; no second entry validator. */
export const ProviderConnectionsCatalogV1Schema = lazyZodSchema(() => z.omit(ProviderSettingsV1BaseSchema, { defaultsByAgentTargetKey: true }).check(z.superRefine((catalog, context) => refineProviderSettingsV1({ ...catalog, defaultsByAgentTargetKey: {} }, context))));
export type ProviderConnectionsCatalogV1 = z.infer<typeof ProviderConnectionsCatalogV1Schema>;
export const StoredProviderConnectionsCatalogV1Schema = createStoredReadSchema(ProviderConnectionsCatalogV1Schema);

export const ProviderConnectionsContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: ProviderConnectionsCatalogV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type ProviderConnectionsContentV1 = z.infer<typeof ProviderConnectionsContentV1Schema>;

function admitProviderCatalogJson(value: unknown, context: z.core.ParsePayload) {
  const parsed = StrictJsonValueSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) context.issues.push({ ...issue, input: 'input' in issue ? issue.input ?? context.value : context.value } as z.core.$ZodRawIssue);
  return z.NEVER;
}

/** Keep the original body until the domain opener has checked the complete inventory. */
export const StoredProviderConnectionsContentV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(admitProviderCatalogJson), z.discriminatedUnion('t', [
  z.catchall(z.object({ t: z.literal('plain'), v: PluginJsonValueV2Schema }), PluginJsonValueV2Schema),
  z.catchall(z.object({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }), PluginJsonValueV2Schema),
])));
export type StoredProviderConnectionsContentV1 = z.infer<typeof StoredProviderConnectionsContentV1Schema>;

/** Conversion preserves the original stored body after complete domain admission. */
export const ProviderConnectionsMigrationContentV1Schema = StoredProviderConnectionsContentV1Schema;
export type ProviderConnectionsMigrationContentV1 = z.infer<typeof ProviderConnectionsMigrationContentV1Schema>;

const revision = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const ProviderConnectionsRowFailureV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']), reason: z.optional(z.string()),
}));
export const ProviderConnectionsRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('present'), revision, content: StoredProviderConnectionsContentV1Schema }),
  z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('deleted'), revision }), ProviderConnectionsRowFailureV1Schema,
]));
export const ProviderConnectionsRowMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([revision, z.literal('absent')]), content: z.nullable(ProviderConnectionsContentV1Schema), sourceSettingsVersion: z.optional(revision),
  referencedSavedSecretIds: z.array(z.string().check(z.refine(isCanonicalProviderSavedSecretIdV1, 'SavedSecret reference must be canonical'))),
  savedSecretRevisions: z.array(z.strictObject({ resourceId: z.string().check(z.minLength(1)), expectedRevision: revision })),
}).check(z.superRefine((mutation, context) => {
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
})));
export type ProviderConnectionsRowMutationV1 = z.infer<typeof ProviderConnectionsRowMutationV1Schema>;
export const ProviderConnectionsRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), revision, cursor: revision }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1)) }), ProviderConnectionsRowFailureV1Schema,
  z.strictObject({ status: z.literal('settings-conflict'), revision }),
  z.strictObject({ status: z.literal('invalid-reference') }),
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
