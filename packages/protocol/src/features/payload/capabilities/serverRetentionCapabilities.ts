import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

const KeepForeverRetentionPolicySchema = lazyZodSchema(() => z.object({
  mode: z.literal('keep_forever'),
}));

const DeleteOlderThanRetentionPolicySchema = lazyZodSchema(() => z.object({
  mode: z.literal('delete_older_than'),
  days: z.number().check(z.int(), z.minimum(1)),
}));

const DeleteInactiveSessionsRetentionPolicySchema = lazyZodSchema(() => z.object({
  mode: z.literal('delete_inactive'),
  inactivityDays: z.number().check(z.int(), z.minimum(1)),
  requires: z.tuple([z.literal('updatedAt'), z.literal('lastActiveAt')]),
}));

export const AgeBasedRetentionPolicySchema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  KeepForeverRetentionPolicySchema,
  DeleteOlderThanRetentionPolicySchema,
]));

export const SessionRetentionPolicySchema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  KeepForeverRetentionPolicySchema,
  DeleteInactiveSessionsRetentionPolicySchema,
]));

export const ServerRetentionCapabilitiesSchema = lazyZodSchema(() => z.object({
  policyVersion: z.literal(1),
  enabled: z.boolean(),
  sessions: SessionRetentionPolicySchema,
  sessionMessages: z.optional(AgeBasedRetentionPolicySchema),
  accountChanges: AgeBasedRetentionPolicySchema,
  usageEvents: z.optional(AgeBasedRetentionPolicySchema),
  voiceSessionLeases: AgeBasedRetentionPolicySchema,
  userFeedItems: AgeBasedRetentionPolicySchema,
  publicShareAccessLogs: AgeBasedRetentionPolicySchema,
  terminalAuthRequests: AgeBasedRetentionPolicySchema,
  accountAuthRequests: AgeBasedRetentionPolicySchema,
  authPairingSessions: AgeBasedRetentionPolicySchema,
  repeatKeys: AgeBasedRetentionPolicySchema,
  globalLocks: AgeBasedRetentionPolicySchema,
  automationRuns: AgeBasedRetentionPolicySchema,
  automationRunEvents: AgeBasedRetentionPolicySchema,
}));

export type AgeBasedRetentionPolicy = z.infer<typeof AgeBasedRetentionPolicySchema>;
export type SessionRetentionPolicy = z.infer<typeof SessionRetentionPolicySchema>;
export type ServerRetentionCapabilities = z.infer<typeof ServerRetentionCapabilitiesSchema>;
