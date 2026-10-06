import { z } from 'zod';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';

export const SETTINGS_DECLARATION_ACTION_IDS_V1 = ['settings.list', 'settings.get', 'settings.set', 'settings.invoke'] as const;
export type SettingsDeclarationActionIdV1 = typeof SETTINGS_DECLARATION_ACTION_IDS_V1[number];

export function isSettingsDeclarationActionIdV1(value: string): value is SettingsDeclarationActionIdV1 {
  return (SETTINGS_DECLARATION_ACTION_IDS_V1 as readonly string[]).includes(value);
}

/** Values are strict JSON; the declaration's canonical owner admits each setting's shape. */
export const SettingsDeclarationValueV1Schema = StrictJsonValueSchema;
const SettingsDeclarationScalarChoiceV1Schema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const AnchorSchema = z.string().trim().min(1);
const OperationIdSchema = z.string().trim().min(1);
/** Exact operation targets, never a settings path, credential value or caller confirmation. */
export const SettingsDeclarationOperationInputV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model_pack'), packId: OperationIdSchema, machineId: OperationIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('voice_preview'), voiceId: OperationIdSchema }).strict(),
  z.object({ kind: z.literal('diagnostics_enabled'), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('diagnostics_export'), artifactId: OperationIdSchema, machineId: OperationIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('diagnostics_session'), sessionId: OperationIdSchema, machineId: OperationIdSchema }).strict(),
  z.object({ kind: z.literal('diagnostics_revocation'), key: OperationIdSchema, revision: z.number().int().positive().safe() }).strict(),
]);
export type SettingsDeclarationOperationInputV1 = z.infer<typeof SettingsDeclarationOperationInputV1Schema>;
export const SettingsDeclarationDescriptorV1Schema = z.object({
  anchor: AnchorSchema,
  pageId: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  readable: z.boolean(),
  writable: z.boolean(),
  sensitive: z.boolean(),
  storageScope: z.enum(['account', 'local']).optional(),
  allowedValues: z.array(SettingsDeclarationScalarChoiceV1Schema).optional(),
  operation: z.object({ actionId: z.literal('settings.invoke'), requiresHumanInteraction: z.boolean(), requiresApproval: z.boolean().optional() }).strict().optional(),
  unavailableReason: z.enum(['not_bound', 'sensitive', 'read_only', 'unsupported_host', 'feature_disabled']).optional(),
}).strict();
const ValueResultSchema = z.object({ anchor: AnchorSchema, value: SettingsDeclarationValueV1Schema }).strict();

export const SettingsDeclarationActionInputSchemasV1 = {
  'settings.list': z.object({ pageId: z.string().trim().min(1).optional() }).strict(),
  'settings.get': z.object({ anchor: AnchorSchema }).strict(),
  'settings.set': z.object({ anchor: AnchorSchema, value: SettingsDeclarationValueV1Schema }).strict(),
  'settings.invoke': z.object({ anchor: AnchorSchema, input: SettingsDeclarationOperationInputV1Schema.optional() }).strict(),
} as const;
export const SettingsDeclarationActionOutputSchemasV1 = {
  'settings.list': z.object({ items: z.array(SettingsDeclarationDescriptorV1Schema) }).strict(),
  'settings.get': z.union([ValueResultSchema, z.object({ anchor: AnchorSchema, unset: z.literal(true) }).strict()]),
  'settings.set': ValueResultSchema,
  'settings.invoke': z.object({
    anchor: AnchorSchema,
    status: z.enum(['completed', 'cancelled', 'unavailable', 'interaction_opened']),
    reason: z.string().min(1).optional(),
    value: StrictJsonValueSchema.optional(),
  }).strict(),
} as const;
export type SettingsDeclarationDescriptorV1 = z.infer<typeof SettingsDeclarationDescriptorV1Schema>;
