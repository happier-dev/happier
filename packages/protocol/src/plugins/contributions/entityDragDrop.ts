import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { PluginInvocableActionIdSchema } from '../../actions/pluginActionSurface.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../actions/jsonSchemaValidation.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema, qualifyPluginContributionReferenceV1 } from '../contributionIdentity.js';
import { PluginClientExecutionPlatformsV1Schema, PluginClientExecutionReferenceV1Schema } from './clientExecution.js';
import { PluginContributionReferenceV2Schema, PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { isEntityDragKindV1, type EntityDragKindV1 } from '../ui/entityDragDrop.js';

export const PluginEntityDragKindV1Schema = lazyZodSchema(() => z.custom<EntityDragKindV1>(isEntityDragKindV1));

const clientFields = { client: PluginClientExecutionReferenceV1Schema, platforms: PluginClientExecutionPlatformsV1Schema };
export const PluginDragSourceContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  preview: z.object({ subtitle: PluginLocalizedStringV2Schema.optional() }).strict().optional(),
  /** Selects this plugin's existing attachment declaration; never carries authority. */
  composerAttachment: asProtocolZod(PluginContributionLocalIdSchema).optional(),
  referenceSchema: PluginJsonSchemaV2Schema.transform((schema, ctx) => {
    try { return normalizePluginJsonSchema(schema); }
    catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid reference schema' }); return z.NEVER; }
  }),
  ...clientFields,
}).strict());
export type PluginDragSourceContributionV1 = z.infer<typeof PluginDragSourceContributionV1Schema>;

export const PluginEntityDropActionReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), actionId: z.lazy(() => PluginInvocableActionIdSchema) }).strict(),
  z.object({ kind: z.literal('plugin'), action: asProtocolZod(PluginContributionReferenceV2Schema) }).strict(),
]));
export const PluginDropTargetContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema), title: PluginLocalizedStringV2Schema,
  acceptedKinds: z.array(PluginEntityDragKindV1Schema).min(1),
  actions: z.array(PluginEntityDropActionReferenceV1Schema).min(1),
  ...clientFields,
}).strict());
export type PluginDropTargetContributionV1 = z.infer<typeof PluginDropTargetContributionV1Schema>;

/** Schema admission reuses the incumbent compiler, never a feature-local validator. */
export function validatePluginDragSourceReferenceV1(descriptor: Pick<PluginDragSourceContributionV1, 'referenceSchema'>, reference: unknown): boolean {
  return isValidPluginJsonSchemaValue(compilePluginJsonSchema(descriptor.referenceSchema), reference);
}

/** Declaration allowlisting does not replace the host Action's current policy. */
export function isPluginDropTargetActionAllowedV1(descriptor: PluginDropTargetContributionV1, declaringPluginId: string, actionId: string): boolean {
  return descriptor.actions.some(action => {
    if (action.kind === 'host') return action.actionId === actionId;
    const identity = qualifyPluginContributionReferenceV1(action.action, declaringPluginId);
    return actionId === `plugin:${identity.pluginId}/${identity.localId}`;
  });
}
