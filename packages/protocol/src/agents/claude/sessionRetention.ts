import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginSettingFieldSchemaV2Schema } from '../../plugins/contributions/settings.js';

export const CLAUDE_SESSION_RETENTION_SETTING_ID = 'claudeSessionRetentionV1';
export const CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export const ClaudeSessionRetentionPolicyV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('providerDefault') }),
  z.strictObject({ mode: z.literal('days'), days: z.number().check(z.int(), z.minimum(1)) }),
]));
export type ClaudeSessionRetentionPolicyV1 = z.infer<typeof ClaudeSessionRetentionPolicyV1Schema>;

export const ClaudeSessionRetentionSettingV1Schema = lazyZodSchema(() => z.nullable(ClaudeSessionRetentionPolicyV1Schema));

/** The declarative plugin field and runtime editor consume the same policy schema. */
export function claudeSessionRetentionSettingJsonSchema() {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(ClaudeSessionRetentionSettingV1Schema);
  return PluginSettingFieldSchemaV2Schema.parse(schema);
}

export const ClaudeSessionRetentionReportV1Schema = lazyZodSchema(() => z.strictObject({
  policy: ClaudeSessionRetentionSettingV1Schema,
  targets: z.array(z.strictObject({
    id: z.string().check(z.minLength(1)),
    status: z.enum(['applied', 'unmanaged', 'error', 'managed']),
    currentDays: z.nullable(z.number().check(z.int(), z.nonnegative())),
    reason: z.optional(z.string()),
  })),
}));
export type ClaudeSessionRetentionReportV1 = z.infer<typeof ClaudeSessionRetentionReportV1Schema>;
