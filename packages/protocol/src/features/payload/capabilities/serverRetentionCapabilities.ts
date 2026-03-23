import { z } from 'zod';

const KeepForeverRetentionPolicySchema = z.strictObject({
  mode: z.literal('keep_forever'),
});

const DeleteOlderThanRetentionPolicySchema = z.strictObject({
  mode: z.literal('delete_older_than'),
  days: z.number().int().min(1),
});

const DeleteInactiveSessionsRetentionPolicySchema = z.strictObject({
  mode: z.literal('delete_inactive'),
  inactivityDays: z.number().int().min(1),
  requires: z.tuple([z.literal('updatedAt'), z.literal('lastActiveAt')]),
});

export const AgeBasedRetentionPolicySchema = z.discriminatedUnion('mode', [
  KeepForeverRetentionPolicySchema,
  DeleteOlderThanRetentionPolicySchema,
]);

export const SessionRetentionPolicySchema = z.discriminatedUnion('mode', [
  KeepForeverRetentionPolicySchema,
  DeleteInactiveSessionsRetentionPolicySchema,
]);

export const ServerRetentionCapabilitiesSchema = z.strictObject({
  policyVersion: z.literal(1),
  enabled: z.boolean(),
  sessions: SessionRetentionPolicySchema,
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
});

export type AgeBasedRetentionPolicy = z.infer<typeof AgeBasedRetentionPolicySchema>;
export type SessionRetentionPolicy = z.infer<typeof SessionRetentionPolicySchema>;
export type ServerRetentionCapabilities = z.infer<typeof ServerRetentionCapabilitiesSchema>;
