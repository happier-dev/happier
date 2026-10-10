import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PLUGIN_COLLECTION_LIMITS_V1 } from './collectionLimitsV1.js';
import {
  PluginCollectionSchemaVersionV1Schema,
  type PluginCollectionSchemaVersionV1,
} from './collectionContractRefV1.js';
import { PluginJsonSchemaV2Schema, type PluginJsonSchemaV2 } from '../contributions/publicTypes.js';
import { MAX_PLUGIN_IDENTIFIER_BYTES } from '../pluginId.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const PLUGIN_COLLECTION_MEMBER_NAME_V1_PATTERN = /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;

/**
 * One grammar for Collection-local names. Collection contribution identities
 * stay on `PluginContributionLocalIdSchema`; this only names members within a
 * declared Collection contract.
 */
export const PluginCollectionMemberNameV1Schema = lazyZodSchema(() => z.string()
  .max(MAX_PLUGIN_IDENTIFIER_BYTES)
  .regex(
    PLUGIN_COLLECTION_MEMBER_NAME_V1_PATTERN,
    'Collection member names must start lower-case, use ASCII alphanumerics, and use only single internal hyphens.',
  ));
export type PluginCollectionMemberNameV1 = z.infer<typeof PluginCollectionMemberNameV1Schema>;

/**
 * One serializable edge in an Account Collection's finite schema-evolution
 * chain. The executable callback is candidate code and is deliberately not a
 * Protocol or manifest field.
 */
export const PluginCollectionMigrationDeclarationV1Schema = lazyZodSchema(() => z.object({
  id: PluginCollectionMemberNameV1Schema,
  fromSchemaVersion: z.number().int().min(1),
  toSchemaVersion: z.number().int().min(1),
}).strict());
export type PluginCollectionMigrationDeclarationV1 = z.infer<
  typeof PluginCollectionMigrationDeclarationV1Schema
>;

/**
 * Exact executable Artifact selected by an authored Account Collection that
 * declares migrations. The reference grants authority only to this
 * contribution family; a renderer or another executable family naming the
 * same export does not become a Collection migration owner.
 */
export const PluginCollectionMigrationArtifactReferenceV1Schema = lazyZodSchema(() => z.object({
  artifactId: asProtocolZod(PluginContributionLocalIdSchema),
  exportName: z.literal('collectionMigrations'),
}).strict());
export type PluginCollectionMigrationArtifactReferenceV1 = z.infer<
  typeof PluginCollectionMigrationArtifactReferenceV1Schema
>;

export type PluginCollectionMigrationArtifactOwnerV1 = Readonly<{
  contributionId: string;
  reference: PluginCollectionMigrationArtifactReferenceV1;
}>;

/**
 * Resolves the exact static migration declaration slice admitted by the
 * target Collection contract. Executable callbacks remain host-owned and are
 * selected by matching these declaration identities.
 */
export function resolvePluginCollectionMigrationChainV1(input: Readonly<{
  targetSchemaVersion: PluginCollectionSchemaVersionV1;
  readableSchemaVersions: readonly PluginCollectionSchemaVersionV1[];
  migrations: readonly PluginCollectionMigrationDeclarationV1[];
  sourceSchemaVersion: PluginCollectionSchemaVersionV1;
}>): readonly PluginCollectionMigrationDeclarationV1[] | null {
  if (input.sourceSchemaVersion > input.targetSchemaVersion) return null;
  const sourcePosition = input.readableSchemaVersions.indexOf(input.sourceSchemaVersion);
  if (sourcePosition < 0) return null;
  const chain = input.migrations.slice(sourcePosition);
  let currentVersion = input.sourceSchemaVersion;
  for (const migration of chain) {
    if (migration.fromSchemaVersion !== currentVersion) return null;
    currentVersion = migration.toSchemaVersion;
  }
  return currentVersion === input.targetSchemaVersion
    ? Object.freeze(chain)
    : null;
}

/**
 * Collection field references are root-object members. Keep their grammar on
 * the schema owner so author input and persisted reconstruction cannot drift.
 */
export const PluginCollectionSchemaV1Schema: z.ZodType<PluginJsonSchemaV2> = lazyZodSchema(() => PluginJsonSchemaV2Schema.superRefine(
  (schema, context) => {
    for (const field of Object.keys(schema.properties ?? {})) {
      if (!PluginCollectionMemberNameV1Schema.safeParse(field).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['properties', field],
          message: 'Collection schema properties must use the Collection-member grammar.',
        });
      }
    }
    for (const [position, field] of (schema.required ?? []).entries()) {
      if (!PluginCollectionMemberNameV1Schema.safeParse(field).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['required', position],
          message: 'Required Collection schema fields must use the Collection-member grammar.',
        });
      }
    }
  },
));

export const PluginCollectionScalarKindV1Schema = lazyZodSchema(() => z.enum(['string', 'finiteNumber', 'boolean', 'instant']));
export type PluginCollectionScalarKindV1 = z.infer<typeof PluginCollectionScalarKindV1Schema>;

export const PluginCollectionFiniteNumberV1Schema = lazyZodSchema(() => z.number().finite());
const MAX_COLLECTION_PROJECTED_STRING_UTF8_BYTES = 4 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const PluginCollectionProjectedStringV1Schema = lazyZodSchema(() => z.string().superRefine((value, context) => {
  if (utf8ByteLength(value) > MAX_COLLECTION_PROJECTED_STRING_UTF8_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Projected string exceeds the 4 KiB limit.' });
  }
}));

export const PluginCollectionProjectedScalarValueV1Schema = lazyZodSchema(() => z.union([
  z.null(),
  z.boolean(),
  PluginCollectionProjectedStringV1Schema,
  PluginCollectionFiniteNumberV1Schema,
]));

const StringParameterSchema = lazyZodSchema(() => z.object({
  kind: z.literal('string'),
  maxUtf8Bytes: z.number().int().min(1).max(256),
  enum: z.array(z.string().min(1).max(256)).min(1).max(64).optional(),
}).strict().superRefine((value, context) => {
  if (value.enum && new Set(value.enum).size !== value.enum.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['enum'], message: 'String enum values must be unique.' });
  }
}));
const FiniteNumberParameterSchema = lazyZodSchema(() => z.object({
  kind: z.literal('finiteNumber'),
  minimum: PluginCollectionFiniteNumberV1Schema.optional(),
  maximum: PluginCollectionFiniteNumberV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['maximum'], message: 'maximum must not be below minimum.' });
  }
}));
const BooleanParameterSchema = lazyZodSchema(() => z.object({ kind: z.literal('boolean') }).strict());
const InstantParameterSchema = lazyZodSchema(() => z.object({ kind: z.literal('instant') }).strict());

export const PluginCollectionUiQueryParameterV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  StringParameterSchema,
  FiniteNumberParameterSchema,
  BooleanParameterSchema,
  InstantParameterSchema,
]));
export type PluginCollectionUiQueryParameterV1 = z.infer<typeof PluginCollectionUiQueryParameterV1Schema>;

export const PluginCollectionUiQueryValueV1Schema = lazyZodSchema(() => z.union([
  z.object({
    kind: z.literal('literal'),
    value: z.union([z.null(), z.boolean(), z.string(), PluginCollectionFiniteNumberV1Schema]),
  }).strict(),
  z.object({ kind: z.literal('parameter'), parameterId: PluginCollectionMemberNameV1Schema }).strict(),
]));
export type PluginCollectionUiQueryValueV1 = z.infer<typeof PluginCollectionUiQueryValueV1Schema>;

export const PluginCollectionIndexFieldV1Schema = lazyZodSchema(() => z.object({
  field: PluginCollectionMemberNameV1Schema,
  direction: z.enum(['asc', 'desc']).default('asc'),
}).strict());
export type PluginCollectionIndexFieldV1 = z.infer<typeof PluginCollectionIndexFieldV1Schema>;

export const PluginCollectionIndexV1Schema = lazyZodSchema(() => z.object({
  id: PluginCollectionMemberNameV1Schema,
  fields: z.array(PluginCollectionIndexFieldV1Schema).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (new Set(value.fields.map((field) => field.field)).size !== value.fields.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields'], message: 'Index fields must be unique.' });
  }
}));
export type PluginCollectionIndexV1 = z.infer<typeof PluginCollectionIndexV1Schema>;

export const PluginCollectionUiQueryDescriptorV1Schema = lazyZodSchema(() => z.object({
  id: PluginCollectionMemberNameV1Schema,
  indexId: PluginCollectionMemberNameV1Schema,
  parameters: z.record(PluginCollectionMemberNameV1Schema, PluginCollectionUiQueryParameterV1Schema).default({}),
  prefix: z.array(PluginCollectionUiQueryValueV1Schema).max(4).default([]),
  range: z.object({
    lower: PluginCollectionUiQueryValueV1Schema.optional(),
    upper: PluginCollectionUiQueryValueV1Schema.optional(),
  }).strict().refine(
    (value) => value.lower !== undefined || value.upper !== undefined,
    'A range needs a lower or upper bound.',
  ).optional(),
  order: z.enum(['asc', 'desc']),
  pageSize: z.number().int().min(1).max(200),
  projectedFields: z.array(PluginCollectionMemberNameV1Schema).min(1).max(16),
}).strict().superRefine((value, context) => {
  if (new Set(value.projectedFields).size !== value.projectedFields.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectedFields'], message: 'Projected fields must be unique.' });
  }
}));
export type PluginCollectionUiQueryDescriptorV1 = z.infer<typeof PluginCollectionUiQueryDescriptorV1Schema>;

const PluginCollectionSamePluginRelationV1Schema = lazyZodSchema(() => z.object({
  id: PluginCollectionMemberNameV1Schema,
  kind: z.literal('collection'),
  field: PluginCollectionMemberNameV1Schema,
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  required: z.boolean(),
  unique: z.boolean().optional(),
  onDelete: z.enum(['restrict', 'nullify']),
}).strict().superRefine((value, context) => {
  if (value.required && value.onDelete === 'nullify') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['onDelete'],
      message: 'Required collection relations cannot nullify.',
    });
  }
}));
const PluginCollectionHostRelationV1Schema = lazyZodSchema(() => z.object({
  id: PluginCollectionMemberNameV1Schema,
  kind: z.literal('host'),
  field: PluginCollectionMemberNameV1Schema,
  hostKind: z.enum(['account', 'machine', 'session', 'message', 'artifact', 'connectedAccount']),
}).strict());
export const PluginCollectionRelationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginCollectionSamePluginRelationV1Schema,
  PluginCollectionHostRelationV1Schema,
]));
export type PluginCollectionRelationV1 = z.infer<typeof PluginCollectionRelationV1Schema>;

export const PluginCollectionIndexPrefixQuotaV1Schema = lazyZodSchema(() => z.object({
  indexId: PluginCollectionMemberNameV1Schema,
  prefix: z.array(PluginCollectionProjectedScalarValueV1Schema).min(1).max(4),
  maxRows: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumAccountRows),
}).strict());
export type PluginCollectionIndexPrefixQuotaV1 = z.infer<typeof PluginCollectionIndexPrefixQuotaV1Schema>;

export const PluginCollectionQuotaRequestV1Schema = lazyZodSchema(() => z.object({
  maxRows: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumAccountRows).optional(),
  maxCollectionEncodedBytes: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumAccountEncodedBytes).optional(),
  maxRowEncodedBytes: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumStoredRowEncodedBytes).optional(),
  maxRowsByIndexPrefix: z.array(PluginCollectionIndexPrefixQuotaV1Schema).min(1).max(8).optional(),
}).strict().refine(
  (value) => value.maxRows !== undefined
    || value.maxCollectionEncodedBytes !== undefined
    || value.maxRowEncodedBytes !== undefined
    || value.maxRowsByIndexPrefix !== undefined,
  'A collection quota request must name at least one limit.',
));
export type PluginCollectionQuotaRequestV1 = z.infer<typeof PluginCollectionQuotaRequestV1Schema>;

export const PluginCollectionProjectedScalarFieldRefV1Schema = lazyZodSchema(() => z.object({
  field: PluginCollectionMemberNameV1Schema,
  kind: PluginCollectionScalarKindV1Schema,
}).strict());
export type PluginCollectionProjectedScalarFieldRefV1 = z.infer<
  typeof PluginCollectionProjectedScalarFieldRefV1Schema
>;

/**
 * The one admission rule for a Collection `schemaVersion`, wherever it crosses a wire
 * or a projection. Versions start at 1 and stop at what the persisted column can hold,
 * so the author's declaration, an admitted contract ref, a writer context, the stored
 * contract and the UI projection cannot disagree about which versions exist.
 */
export { PluginCollectionSchemaVersionV1Schema, type PluginCollectionSchemaVersionV1 } from './collectionContractRefV1.js';

/** Static, descriptor-only contribution. Runtime collection registration is intentionally absent. */
export const PluginAccountCollectionContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  schema: PluginCollectionSchemaV1Schema,
  rowIdField: PluginCollectionMemberNameV1Schema.default('id'),
  serverReadable: z.array(PluginCollectionMemberNameV1Schema).min(1).max(16),
  indexes: z.array(PluginCollectionIndexV1Schema).max(8),
  uiQueries: z.array(PluginCollectionUiQueryDescriptorV1Schema).max(16).default([]),
  relations: z.array(PluginCollectionRelationV1Schema).max(16).default([]),
  quota: PluginCollectionQuotaRequestV1Schema.optional(),
  readableSchemaVersions: z.array(PluginCollectionSchemaVersionV1Schema).max(32).optional(),
  migrations: z.array(PluginCollectionMigrationDeclarationV1Schema).max(32).default([]),
  migrationArtifact: PluginCollectionMigrationArtifactReferenceV1Schema.optional(),
  /**
   * The declared fields whose stored value is a mode-derived identity tag, so
   * the value the plugin can re-derive depends on the Account's encryption
   * mode. Row addresses and indexed values are plaintext server metadata, and
   * the tag derivation is deliberately unkeyed on a plaintext Account and
   * Account-keyed on an E2EE one; a mode transition therefore changes every
   * such value while the platform holds neither the Account key material nor
   * the plugin's private components needed to recompute it. Declaring the set
   * is what lets the Account transition owner refuse rather than strand.
   */
  identityFields: z.array(PluginCollectionMemberNameV1Schema).max(16).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.serverReadable).size !== value.serverReadable.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['serverReadable'], message: 'Server-readable fields must be unique.' });
  }
  const indexIds = new Set<string>();
  value.indexes.forEach((index, indexPosition) => {
    if (indexIds.has(index.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['indexes', indexPosition, 'id'], message: 'Index ids must be unique.' });
    }
    indexIds.add(index.id);
  });
  const queryIds = new Set<string>();
  value.uiQueries.forEach((query, queryPosition) => {
    if (queryIds.has(query.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['uiQueries', queryPosition, 'id'], message: 'UI query ids must be unique.' });
    }
    queryIds.add(query.id);
  });
  const relationIds = new Set<string>();
  const relationFields = new Set<string>();
  value.relations.forEach((relation, relationPosition) => {
    if (relationIds.has(relation.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['relations', relationPosition, 'id'], message: 'Relation ids must be unique.' });
    }
    relationIds.add(relation.id);
    if (relationFields.has(relation.field)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['relations', relationPosition, 'field'], message: 'Relation fields must be unique.' });
    }
    relationFields.add(relation.field);
  });
  if (new Set(value.identityFields).size !== value.identityFields.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['identityFields'], message: 'Identity fields must be unique.' });
  }
  const identityAddressableFields = new Set<string>([
    value.rowIdField,
    ...value.indexes.flatMap((index) => index.fields.map((field) => field.field)),
  ]);
  value.identityFields.forEach((field, position) => {
    if (!identityAddressableFields.has(field)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityFields', position],
        message: 'Identity fields must name the row-id field or a declared index field.',
      });
    }
  });
  if (value.readableSchemaVersions && new Set(value.readableSchemaVersions).size !== value.readableSchemaVersions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['readableSchemaVersions'], message: 'Readable schema versions must be unique.' });
  }
  const readableSchemaVersions = [...new Set([
    value.schemaVersion,
    ...(value.readableSchemaVersions ?? []),
  ])].sort((left, right) => left - right);
  // A retained reader may explicitly promise that its logical decoder accepts
  // a later schema version. Forward-readable declarations do not imply a
  // migration callback: only versions at or below this artifact's own schema
  // can be source rows that this artifact migrates into its current shape.
  const migrationSchemaVersions = readableSchemaVersions.filter(
    (version) => version <= value.schemaVersion,
  );
  const migrationIds = new Set<string>();
  value.migrations.forEach((migration, position) => {
    if (migrationIds.has(migration.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['migrations', position, 'id'], message: 'Migration ids must be unique.' });
    }
    migrationIds.add(migration.id);
    const fromSchemaVersion = migrationSchemaVersions[position];
    const toSchemaVersion = migrationSchemaVersions[position + 1];
    if (migration.fromSchemaVersion !== fromSchemaVersion || migration.toSchemaVersion !== toSchemaVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['migrations', position],
        message: 'Migrations must be the ordered adjacent edges for declared readable schema versions.',
      });
    }
  });
  if (value.migrations.length !== migrationSchemaVersions.length - 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['migrations'],
      message: 'Migrations must cover every ordered adjacent declared readable schema-version edge exactly once.',
    });
  }
  if (value.migrations.length === 0 && value.migrationArtifact !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['migrationArtifact'],
      message: 'A Collection without migrations must not declare a migration Artifact.',
    });
  }
}));
export type PluginAccountCollectionContributionV1 = z.infer<
  typeof PluginAccountCollectionContributionV1Schema
>;

/**
 * Resolves the one exact migration Artifact owner for a plugin release. The
 * current candidate protocol carries one digest for the complete preparation,
 * so zero, missing, or competing owners fail closed instead of being merged by
 * a consumer-local registry.
 */
export function resolvePluginCollectionMigrationArtifactOwnerV1(
  contributions: readonly PluginAccountCollectionContributionV1[],
): PluginCollectionMigrationArtifactOwnerV1 | null {
  const owners = contributions.filter((contribution) => contribution.migrations.length > 0);
  if (owners.length !== 1 || !owners[0]!.migrationArtifact) return null;
  return Object.freeze({
    contributionId: owners[0]!.id,
    reference: Object.freeze({ ...owners[0]!.migrationArtifact }),
  });
}
