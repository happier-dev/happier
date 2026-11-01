import { z } from 'zod';
import { lazySchema } from '../../../lazySchema.js';

const KeepForeverRetentionPolicySchema = lazySchema(() => z.strictObject({
  mode: z.literal('keep_forever'),
}));

const DeleteOlderThanRetentionPolicySchema = lazySchema(() => z.strictObject({
  mode: z.literal('delete_older_than'),
  days: z.number().int().min(1),
}));

const DeleteInactiveSessionsRetentionPolicySchema = lazySchema(() => z.strictObject({
  mode: z.literal('delete_inactive'),
  inactivityDays: z.number().int().min(1),
  requires: z.tuple([z.literal('updatedAt'), z.literal('lastActiveAt')]),
}));

export const AgeBasedRetentionPolicySchema = lazySchema(() => z.discriminatedUnion('mode', [
  KeepForeverRetentionPolicySchema,
  DeleteOlderThanRetentionPolicySchema,
]));

export const SessionRetentionPolicySchema = lazySchema(() => z.discriminatedUnion('mode', [
  KeepForeverRetentionPolicySchema,
  DeleteInactiveSessionsRetentionPolicySchema,
]));

export const ServerRetentionCapabilitiesSchema = lazySchema(() => z.strictObject({
  policyVersion: z.literal(1),
  enabled: z.boolean(),
  sessions: SessionRetentionPolicySchema,
  sessionMessages: AgeBasedRetentionPolicySchema.optional(),
  accountChanges: AgeBasedRetentionPolicySchema,
  voiceSessionLeases: AgeBasedRetentionPolicySchema,
  userFeedItems: AgeBasedRetentionPolicySchema,
  sessionShareAccessLogs: AgeBasedRetentionPolicySchema,
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
