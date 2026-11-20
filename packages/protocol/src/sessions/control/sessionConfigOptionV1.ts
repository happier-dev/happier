import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { z } from '../../zodRuntimePolicy.js';

export const SESSION_CONFIG_OPTION_IDS_SOURCE_ID = 'session.config_option.ids';
export const SESSION_CONFIG_OPTION_VALUES_SOURCE_ID = 'session.config_option.values';
export const SESSION_CONTEXT_USAGE_REFRESH_OPTION_ID = 'context_usage_refresh';
export const SESSION_CONTEXT_USAGE_REFRESH_VALUE_ID = 'refresh';

export const SessionConfigOptionTargetSchema = z.strictObject({
  sessionId: NonBlankOpaqueIdentifierSchema,
});

export const SessionConfigOptionRequestSchema = z.extend(SessionConfigOptionTargetSchema, {
  configId: NonBlankOpaqueIdentifierSchema,
  valueId: z.nullable(z.string()),
});

export const SessionConfigOptionWriteReceiptSchema = z.object({
  ...SessionConfigOptionRequestSchema.shape,
  metadataVersion: z.int().check(z.gte(0)),
});

export const SessionConfigOptionChoicesSchema = z.object({
  options: z.array(z.object({
    id: NonBlankOpaqueIdentifierSchema,
    label: z.string(),
    values: z.array(z.object({ id: z.string(), label: z.string() })),
  })),
});

export type SessionConfigOptionRequest = z.infer<typeof SessionConfigOptionRequestSchema>;
export type SessionConfigOptionWriteReceipt = z.infer<typeof SessionConfigOptionWriteReceiptSchema>;
export type SessionConfigOptionChoices = z.infer<typeof SessionConfigOptionChoicesSchema>;
