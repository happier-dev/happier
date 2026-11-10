import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '../../control/runtimeIssueV1.js';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceQuotaRecoveryCreditsV1Schema,
} from '../../../connect/connectedServiceSchemas.js';
import { ConnectedAccountServiceKeyIngressSchema } from '../../../connect/connectedServiceBindings.js';

export const SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID = 'runtime.usageLimitRecovery' as const;
export const SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY = 'sessionUsageLimitRecoveryV1' as const;

const SessionUsageLimitRecoveryNativeAuthSelectionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('native'),
    serviceId: z.optional(z.nullable(ConnectedAccountServiceKeyIngressSchema)),
  }));

const SessionUsageLimitRecoveryProfileAuthSelectionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('profile'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    profileId: ConnectedServiceProfileIdSchema,
  }));

const SessionUsageLimitRecoveryGroupAuthSelectionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('group'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    profileId: z.nullable(ConnectedServiceProfileIdSchema),
  }));

export const SessionUsageLimitRecoveryAuthSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionUsageLimitRecoveryNativeAuthSelectionV1Schema,
  SessionUsageLimitRecoveryProfileAuthSelectionV1Schema,
  SessionUsageLimitRecoveryGroupAuthSelectionV1Schema,
]));
export type SessionUsageLimitRecoveryAuthSelectionV1 = z.infer<
  typeof SessionUsageLimitRecoveryAuthSelectionV1Schema
>;

export const SessionUsageLimitRecoveryStatusV1Schema = lazyZodSchema(() => z.enum([
  'armed',
  'waiting',
  'checking',
  'paused',
  'exhausted',
  'cancelled',
]));
export type SessionUsageLimitRecoveryStatusV1 = z.infer<typeof SessionUsageLimitRecoveryStatusV1Schema>;

export const SessionUsageLimitRecoveryResumePromptModeV1Schema = lazyZodSchema(() => z.enum(['standard', 'off', 'custom']));
export type SessionUsageLimitRecoveryResumePromptModeV1 =
  z.infer<typeof SessionUsageLimitRecoveryResumePromptModeV1Schema>;

export const SessionUsageLimitRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    status: SessionUsageLimitRecoveryStatusV1Schema,
    resumePromptMode: z._default(SessionUsageLimitRecoveryResumePromptModeV1Schema, 'standard'),
    issueFingerprint: z.string().check(z.trim(), z.minLength(1)),
    armedAtMs: z.number().check(z.int(), z.nonnegative()),
    runtimeAuthRecoveryAttemptId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    resetAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    nextCheckAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    attemptCount: z.number().check(z.int(), z.nonnegative()),
    maxAttempts: z.number().check(z.int(), z.nonnegative()),
    lastProbeError: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1Schema,
    recoveryCredits: z.optional(ConnectedServiceQuotaRecoveryCreditsV1Schema),
  }));
export type SessionUsageLimitRecoveryV1 = z.infer<typeof SessionUsageLimitRecoveryV1Schema>;

/** Presentation only: never carries selected credential/profile identities or resume configuration. */
export const SessionUsageLimitRecoveryDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.pick(SessionUsageLimitRecoveryV1Schema, {
    v: true, status: true, issueFingerprint: true, armedAtMs: true, resetAtMs: true,
    nextCheckAtMs: true, attemptCount: true, maxAttempts: true, lastProbeError: true,
  }).shape,
  authSelectionKind: z.enum(['native', 'profile', 'group']),
}));
export type SessionUsageLimitRecoveryDisplayV1 = z.infer<typeof SessionUsageLimitRecoveryDisplayV1Schema>;
export type SessionUsageLimitRecoveryPresentationV1 = Pick<SessionUsageLimitRecoveryV1, 'status' | 'issueFingerprint'>;

/** Full readers and display-only readers share one projection, without fabricating full recovery state. */
export function projectSessionUsageLimitRecoveryDisplayV1(
  recovery: SessionUsageLimitRecoveryV1 | SessionUsageLimitRecoveryDisplayV1 | null | undefined,
): SessionUsageLimitRecoveryDisplayV1 | null {
  if (!recovery) return null;
  if ('authSelectionKind' in recovery) return recovery;
  return {
    v: 1, status: recovery.status, issueFingerprint: recovery.issueFingerprint,
    armedAtMs: recovery.armedAtMs, resetAtMs: recovery.resetAtMs, nextCheckAtMs: recovery.nextCheckAtMs,
    attemptCount: recovery.attemptCount, maxAttempts: recovery.maxAttempts, lastProbeError: recovery.lastProbeError,
    authSelectionKind: recovery.selectedAuth.kind,
  };
}

/** Stable issue identity shared by recovery producers, controls, and presentation. */
export function buildUsageLimitIssueFingerprint(issue: SessionRuntimeIssueV1, fallbackAgentId = 'unknown-agent'): string {
  return ['usage-limit', issue.agentId ?? fallbackAgentId, issue.agentTurnId ?? 'unknown-turn',
    String(issue.occurredAt), String(issue.usageLimit?.resetAtMs ?? 'no-reset')].join(':');
}

export function isSessionUsageLimitRecoveryForIssue(
  issue: SessionRuntimeIssueV1,
  recovery: Pick<SessionUsageLimitRecoveryV1, 'issueFingerprint'>,
  fallbackAgentId?: string,
): boolean {
  return recovery.issueFingerprint === buildUsageLimitIssueFingerprint(issue, fallbackAgentId)
    // 0.2 used this sentinel when the issue carried no provider identity. The issue ingress
    // already translates provider/providerTurnId; this preserves only the absent-id spelling.
    || (!issue.agentId && recovery.issueFingerprint === buildUsageLimitIssueFingerprint(issue, 'unknown-provider'));
}

/** A different observed failure cannot inherit an earlier recovery's authority. */
export function readSessionUsageLimitRecoveryForIssue(
  value: unknown,
  issue?: SessionRuntimeIssueV1 | null,
  fallbackAgentId?: string,
): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return issue && !isSessionUsageLimitRecoveryForIssue(issue, parsed.data, fallbackAgentId)
    ? null
    : parsed.data;
}

export const SessionStateUsageLimitRecoveryValueSchema = SessionUsageLimitRecoveryV1Schema;

/** Metadata is admitted once at the boundary, then the typed value is carried by its readers. */
export function readSessionUsageLimitRecoveryFromMetadata(metadata: unknown): SessionUsageLimitRecoveryV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = Reflect.get(metadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY);
  return value == null ? null : readSessionUsageLimitRecoveryForIssue(value);
}

/** The blocking issue is independent of whether automatic recovery is enabled or acknowledged. */
export function isSessionUsageLimitIssueCurrentV1(input: Readonly<{
  issue: SessionRuntimeIssueV1 | null | undefined;
  recovery?: SessionUsageLimitRecoveryPresentationV1 | null;
  latestTurnStatus?: PrimaryTurnStatusV1 | null;
  hasActivityAfterRuntimeIssue?: boolean;
}>): boolean {
  const issue = input.issue;
  if (!issue || (issue.source !== 'usage_limit' && issue.code !== 'usage_limit')) return false;
  if (input.recovery?.status === 'cancelled' && isSessionUsageLimitRecoveryForIssue(issue, input.recovery)) return false;
  if (input.latestTurnStatus === 'completed' || input.latestTurnStatus === 'waiting') return false;
  return !(input.latestTurnStatus === 'in_progress' && input.hasActivityAfterRuntimeIssue === true);
}
