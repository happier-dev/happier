import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { PluginActionIconV2Schema } from '../actions/v2.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity, PluginContributionLocalIdSchema, type PluginContributionLocalId } from '../contributionIdentity.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema, type PluginJsonSchemaV2, type PluginLocalizedStringV2 } from './publicTypes.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';

/** Domain identities only: packaged/dynamic resource bytes keep the resources family. */
export type PluginSubjectKindContributionV1 = Readonly<{
  id: PluginContributionLocalId;
  label: PluginLocalizedStringV2;
  icon?: z.infer<typeof PluginActionIconV2Schema>;
  identitySchema: PluginJsonSchemaV2;
  listAction: PluginContributionLocalId;
}>;
export const PluginSubjectKindContributionV1Schema: z.ZodMiniType<PluginSubjectKindContributionV1> = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  label: PluginLocalizedStringV2Schema,
  icon: z.optional(PluginActionIconV2Schema),
  identitySchema: PluginJsonSchemaV2Schema.check(z.superRefine((schema, context) => {
    try {
      normalizePluginJsonSchema(schema);
      if (!isRecursivelyClosedPluginJsonSchemaV2(schema)) context.addIssue({
        code: 'custom', message: 'Subject identity schemas must be recursively closed.',
      });
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid portable subject identity schema.' });
    }
  })),
  listAction: asProtocolZod(PluginContributionLocalIdSchema),
}));

/** The surface requests a page; the declared read Action owns its source's cursor. */
export const PluginSubjectKindListInputV1Schema = lazyZodSchema(() => z.strictObject({
  query: z.optional(z.string()),
  limit: z.optional(z.number().check(z.int(), z.minimum(1))),
  cursor: z.optional(z.string()),
}));
export const PluginSubjectKindListResultV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({ identity: StrictJsonValueSchema, label: z.string().check(z.minLength(1)) })),
  nextCursor: z.nullable(z.string()),
}));
export type PluginSubjectKindListInputV1 = z.infer<typeof PluginSubjectKindListInputV1Schema>;
export type PluginSubjectKindListResultV1 = z.infer<typeof PluginSubjectKindListResultV1Schema>;
export const PluginSubjectKindListInputV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(PluginSubjectKindListInputV1Schema));
export const PluginSubjectKindListResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(PluginSubjectKindListResultV1Schema));

/** Referenced read eligibility is admitted with the declaration, not re-decided by pickers. */
export function validatePluginSubjectKindContributionsV1(value: Readonly<{
  subjectKinds: readonly PluginSubjectKindContributionV1[];
  actions: readonly Readonly<{ id: string; readOnly?: unknown }>[];
}>, context: z.core.$RefinementCtx): void {
  value.subjectKinds.forEach((kind, index) => {
    const action = value.actions.find(candidate => candidate.id === kind.listAction);
    if (!action || action.readOnly !== true) context.addIssue({
      code: 'custom', path: ['subjectKinds', index, 'listAction'],
      message: 'Subject listAction must name a declared read-only Action',
    });
  });
}

/** Cold Account declarations and daemon discovery share this qualified descriptor. */
export function projectPluginSubjectKindDeclarationV1(input: Readonly<{
  pluginId: string;
  pluginVersion: string;
  definition: PluginSubjectKindContributionV1;
}>): import('../../daemon/contributionRegistryProjection.js').PluginProjectedSubjectKindEntryV1 {
  return { ...input, id: buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: input.pluginId, localId: input.definition.id,
  })) };
}
