import { z } from 'zod';

import { lazySchema } from '../../lazySchema.js';

export const ClaudeSessionRetentionPolicyV1Schema = lazySchema(() => z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('providerDefault') }).strict(),
  z.object({ mode: z.literal('days'), days: z.number().int().positive() }).strict(),
]));

export type ClaudeSessionRetentionPolicyV1 = z.infer<typeof ClaudeSessionRetentionPolicyV1Schema>;

export const ClaudeSessionRetentionReportV1Schema = lazySchema(() => z.object({
  policy: ClaudeSessionRetentionPolicyV1Schema.nullable(),
  targets: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['applied', 'unmanaged', 'error', 'managed']),
    currentDays: z.number().int().nonnegative().nullable(),
    reason: z.string().optional(),
  })),
}));

export type ClaudeSessionRetentionReportV1 = z.infer<typeof ClaudeSessionRetentionReportV1Schema>;
