import { z } from 'zod';
import type { SessionRuntimeIssueV1 } from '../sessions/control/runtimeIssueV1.js';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceQuotaRecoveryCreditsV1Schema,
} from '../connect/connectedServiceSchemas.js';
import { lazySchema } from '../lazySchema.js';

export const SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID = 'runtime.usageLimitRecovery' as const;
export const SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY = 'sessionUsageLimitRecoveryV1' as const;

export const SessionUsageLimitRecoveryResumePromptModeV1Schema = lazySchema(() => z.enum(['standard', 'off', 'custom']));
export type SessionUsageLimitRecoveryResumePromptModeV1 =
  z.infer<typeof SessionUsageLimitRecoveryResumePromptModeV1Schema>;

const SessionUsageLimitRecoveryProfileAuthSelectionV1Schema = lazySchema(() => z
  .object({
    kind: z.literal('profile'),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
  })
  .strict());

const SessionUsageLimitRecoveryGroupAuthSelectionV1Schema = lazySchema(() => z
  .object({
    kind: z.literal('group'),
    serviceId: ConnectedServiceIdSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    profileId: ConnectedServiceProfileIdSchema.nullable(),
  })
  .strict());

const SessionUsageLimitRecoveryNativeAuthSelectionV1Schema = lazySchema(() => z
  .object({
    kind: z.literal('native'),
    serviceId: ConnectedServiceIdSchema.nullable().optional(),
  })
  .strict());

export const SessionUsageLimitRecoveryAuthSelectionV1Schema = lazySchema(() => z.discriminatedUnion('kind', [
  SessionUsageLimitRecoveryNativeAuthSelectionV1Schema,
  SessionUsageLimitRecoveryProfileAuthSelectionV1Schema,
  SessionUsageLimitRecoveryGroupAuthSelectionV1Schema,
]));

export type SessionUsageLimitRecoveryAuthSelectionV1 =
  z.infer<typeof SessionUsageLimitRecoveryAuthSelectionV1Schema>;

export const SessionUsageLimitRecoveryV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    status: z.enum(['armed', 'waiting', 'checking', 'paused', 'exhausted', 'cancelled']),
    issueFingerprint: z.string().trim().min(1),
    armedAtMs: z.number().int().nonnegative(),
    runtimeAuthRecoveryAttemptId: z.string().trim().min(1).optional(),
    resetAtMs: z.number().int().nonnegative().nullable(),
    nextCheckAtMs: z.number().int().nonnegative().nullable(),
    attemptCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
    lastProbeError: z.string().trim().min(1).nullable(),
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.default('standard'),
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1Schema,
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1Schema.optional(),
  })
  .strict());

export type SessionUsageLimitRecoveryV1 = z.infer<typeof SessionUsageLimitRecoveryV1Schema>;

/** Stable issue identity shared by recovery producers, controls, and presentation. */
export function buildUsageLimitIssueFingerprint(issue: SessionRuntimeIssueV1, fallbackProviderId = 'unknown-provider'): string {
  return ['usage-limit', issue.provider ?? fallbackProviderId, issue.providerTurnId ?? 'unknown-turn',
    String(issue.occurredAt), String(issue.usageLimit?.resetAtMs ?? 'no-reset')].join(':');
}

export function isSessionUsageLimitRecoveryForIssue(
  issue: SessionRuntimeIssueV1,
  recovery: Pick<SessionUsageLimitRecoveryV1, 'issueFingerprint'>,
  fallbackProviderId?: string,
): boolean {
  return recovery.issueFingerprint === buildUsageLimitIssueFingerprint(issue, fallbackProviderId);
}

/** A different observed failure cannot inherit an earlier recovery's authority. */
export function readSessionUsageLimitRecoveryForIssue(
  value: unknown,
  issue?: SessionRuntimeIssueV1 | null,
  fallbackProviderId?: string,
): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return issue && !isSessionUsageLimitRecoveryForIssue(issue, parsed.data, fallbackProviderId)
    ? null
    : parsed.data;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const parsed = SessionUsageLimitRecoveryResumePromptModeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readAccountSettingsResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const accountSettings = readRecord(value);
  if (!accountSettings) return null;

  const nestedSettings = readRecord(accountSettings.usageLimitRecoverySettingsV1);
  return readResumePromptMode(nestedSettings?.resumePromptMode)
    ?? readResumePromptMode(accountSettings.resumePromptMode);
}

export function resolveSessionUsageLimitRecoveryResumePromptModeV1(input: Readonly<{
  explicit?: unknown;
  existingIntent?: unknown;
  groupPolicy?: unknown;
  accountSettings?: unknown;
}>): SessionUsageLimitRecoveryResumePromptModeV1 {
  const existingIntent = readRecord(input.existingIntent);
  const groupPolicy = readRecord(input.groupPolicy);

  return readResumePromptMode(input.explicit)
    ?? readResumePromptMode(existingIntent?.resumePromptMode)
    ?? readResumePromptMode(groupPolicy?.resumePromptMode)
    ?? readAccountSettingsResumePromptMode(input.accountSettings)
    ?? 'standard';
}
