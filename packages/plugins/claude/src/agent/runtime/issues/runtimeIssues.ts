import { z } from 'zod/mini';
import { SessionRuntimeFailureCauseV1Schema, projectSessionRuntimeFailureCause } from '@happier-dev/plugin-sdk/sessions';
import { ClaudeSessionRuntimeUsageLimitDetailsSchema, ClaudeSessionRuntimeTemporaryThrottleDetailsSchema } from './providerFailureDetails.js';
import { runtimeMeterToQuotaMeter } from '../../auth/services/usage/snapshot.js';
import { resolveClaudeRuntimeQuotaWindows, type NormalizedClaudeRuntimeRateLimitMeter } from '../../auth/services/runtime/usage.js';
import { mapClaudeProviderFailureToUsageDetails as mapProviderFailure } from '../../auth/services/runtime/usage.js';

const ClaudeSessionRuntimeIssueSourceSchema = z.enum([
  'agent_status_error',
  'agent_process_exit',
  'agent_process_exit_after_switch',
  'agent_session_error',
  'usage_limit',
  'auth_error',
  'dependency_failure',
  'stream_error',
  'permission_blocked',
  'unknown',
]);


export const ClaudeSessionRuntimeIssueSchema = z.readonly(z.object({
  v: z.literal(1),
  scope: z.literal('primary_session'),
  status: z.literal('failed'),
  code: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  source: ClaudeSessionRuntimeIssueSourceSchema,
  occurredAt: z.number().check(z.int(), z.nonnegative()),
  sessionSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
  agentTurnId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  sanitizedPreview: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
  failureCause: z.optional(SessionRuntimeFailureCauseV1Schema),
  usageLimit: z.optional(ClaudeSessionRuntimeUsageLimitDetailsSchema),
  temporaryThrottle: z.optional(ClaudeSessionRuntimeTemporaryThrottleDetailsSchema),
  agentProcessExitAfterSwitch: z.optional(z.strictObject({
    exitCode: z.nullable(z.number().check(z.int())),
    signal: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    lastStderrLine: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
    // Claude minted this id: presence-validated, never renormalized.
    vendorResumeId: z.nullable(z.string().check(z.refine((value) => value.trim().length > 0, 'Opaque identifiers must contain a non-whitespace character'), z.maxLength(512))),
    materializationRoot: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
    effectiveStateMode: z.nullable(z.enum(['shared', 'isolated'])),
  })),
}));

export type ClaudeSessionRuntimeIssue = z.infer<typeof ClaudeSessionRuntimeIssueSchema>;
export type ClaudeSessionRuntimeIssueSource = ClaudeSessionRuntimeIssue['source'];
export type ClaudeSessionRuntimeTemporaryThrottleDetails = NonNullable<
  ClaudeSessionRuntimeIssue['temporaryThrottle']
>;
export type ClaudeSessionRuntimeUsageLimitDetails = NonNullable<
  ClaudeSessionRuntimeIssue['usageLimit']
>;

export type ClaudeSessionRuntimeIssueInput = Readonly<{
  code: string;
  source: ClaudeSessionRuntimeIssueSource;
  occurredAt: number;
  sessionSeq?: number | null;
  agentId?: string | null;
  agentTurnId?: string | null;
  sanitizedPreview?: string | null;
  failureCause?: ClaudeSessionRuntimeIssue['failureCause'] | null;
  usageLimit?: ClaudeSessionRuntimeUsageLimitDetails | null;
  temporaryThrottle?: ClaudeSessionRuntimeTemporaryThrottleDetails | null;
  agentProcessExitAfterSwitch?: ClaudeSessionRuntimeIssue['agentProcessExitAfterSwitch'] | null;
}>;

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function buildClaudeSessionRuntimeIssue(
  input: ClaudeSessionRuntimeIssueInput,
): ClaudeSessionRuntimeIssue {
  const code = normalizeBoundedString(input.code, 256) ?? input.source;
  const occurredAt = normalizeNonNegativeInteger(input.occurredAt) ?? Date.now();
  const sessionSeq = normalizeNonNegativeInteger(input.sessionSeq);
  const agentId = normalizeBoundedString(input.agentId, 128);
  const agentTurnId = normalizeBoundedString(input.agentTurnId, 256);
  const sanitizedPreview = normalizeBoundedString(input.sanitizedPreview, 2_000);

  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code,
    source: input.source,
    occurredAt,
    ...(sessionSeq === null ? {} : { sessionSeq }),
    ...(agentId === null ? {} : { agentId }),
    ...(agentTurnId === null ? {} : { agentTurnId }),
    ...(sanitizedPreview === null ? {} : { sanitizedPreview }),
    ...(input.failureCause ? { failureCause: input.failureCause } : {}),
    ...(input.usageLimit ? { usageLimit: input.usageLimit } : {}),
    ...(input.temporaryThrottle ? { temporaryThrottle: input.temporaryThrottle } : {}),
    ...(input.agentProcessExitAfterSwitch
      ? { agentProcessExitAfterSwitch: input.agentProcessExitAfterSwitch }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectEvidenceParts(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceParts(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of [
    'type',
    'code',
    'kind',
    'error',
    'message',
    'detail',
    'description',
    'text',
    'content',
    'last_assistant_message',
    'lastAssistantMessage',
  ]) {
    collectEvidenceParts(value[key], output);
  }
}

function readPreview(value: unknown, fallback?: string | null): string | undefined {
  const parts: string[] = [];
  collectEvidenceParts(value, parts);
  const preview = parts.join(' ').replace(/\s+/gu, ' ').trim() || fallback?.trim() || '';
  return preview ? preview.slice(0, 2_000) : undefined;
}

function buildClaudeIssue(
  issue: ClaudeSessionRuntimeIssueInput,
  evidence: unknown,
  fallbackMessage?: string | null,
): ClaudeSessionRuntimeIssue {
  return buildClaudeSessionRuntimeIssue({
    ...issue,
    failureCause: issue.failureCause ?? projectSessionRuntimeFailureCause(evidence, 'turn', 'agent.turn'),
    sanitizedPreview: readPreview(evidence, fallbackMessage),
  });
}

export function mapClaudeProviderFailureToUsageDetails(
  evidence: unknown,
): ClaudeSessionRuntimeUsageLimitDetails | null {
  const usage = mapProviderFailure(evidence);
  return usage;
}

/** Projects the same request windows as the account snapshot without inventing unknown percentages. */
export function projectClaudeRuntimeIssueQuotaWindows(
  issue: ClaudeSessionRuntimeIssue,
  observedWindows: readonly NormalizedClaudeRuntimeRateLimitMeter[],
): ClaudeSessionRuntimeIssue {
  if (!issue.usageLimit) return issue;
  if (issue.usageLimit.limitCategory === 'rate_limit' && !issue.usageLimit.providerLimitId) {
    return { ...issue, code: 'claude.provider.rate_limit', source: 'agent_status_error',
      usageLimit: { ...issue.usageLimit, utilization: null, resetAtMs: null } };
  }
  const resolved = resolveClaudeRuntimeQuotaWindows(issue.usageLimit, observedWindows);
  const allWindows = resolved.windows.map(runtimeMeterToQuotaMeter).flatMap(meter =>
    typeof meter.remainingPct === 'number' ? [{
      meterId: meter.meterId,
      scope: meter.label,
      remainingPct: meter.remainingPct,
      ...(typeof meter.resetAtMs === 'number' ? { resetAtMs: meter.resetAtMs } : {}),
      status: meter.status,
    }] : []);
  return { ...issue, usageLimit: {
    ...issue.usageLimit, utilization: resolved.utilization, resetAtMs: resolved.resetAtMs,
    ...(resolved.utilization === null ? {} : { effectiveMeterId: resolved.primaryMeterId,
      effectiveRemainingPct: Math.max(0, Math.min(100, 100 - resolved.utilization)) }),
    ...(allWindows.length > 0 ? { allWindows } : {}),
  } };
}

export function buildClaudeRuntimeIssue(params: Readonly<{
  evidence: unknown;
  occurredAt: number;
  fallbackMessage?: string | null;
}>): ClaudeSessionRuntimeIssue {
  const usageLimit = mapClaudeProviderFailureToUsageDetails(params.evidence);
  if (usageLimit?.limitCategory === 'capacity') {
    return buildClaudeIssue({
      code: 'claude.provider.capacity',
      source: 'agent_status_error',
      occurredAt: params.occurredAt,
      agentId: 'claude',
      usageLimit,
    }, params.evidence, params.fallbackMessage);
  }
  if (usageLimit) {
    return projectClaudeRuntimeIssueQuotaWindows(buildClaudeIssue({
      code: 'claude.usage_limit',
      source: 'usage_limit',
      occurredAt: params.occurredAt,
      agentId: 'claude',
      usageLimit,
    }, params.evidence, params.fallbackMessage), []);
  }
  return buildClaudeIssue({
    code: 'claude.provider.failure',
    source: 'agent_session_error',
    occurredAt: params.occurredAt,
    agentId: 'claude',
  }, params.evidence, params.fallbackMessage);
}

export function buildClaudeProcessExitRuntimeIssue(params: Readonly<{
  occurredAt: number;
  exitCode: number | null;
  signal: string | null;
  turnWasInFlight: boolean;
}>): ClaudeSessionRuntimeIssue {
  const exitCode = params.exitCode === null ? '' : ` code ${params.exitCode}`;
  const signal = params.signal ? ` signal ${params.signal}` : '';
  const fallbackMessage = params.turnWasInFlight
    ? `Claude unified terminal process exited while a turn was in flight${exitCode}${signal}`
    : `Claude unified terminal process exited while the session was idle${exitCode}${signal}`;
  return buildClaudeIssue({
    code: 'claude.process_exited',
    source: 'agent_process_exit',
    occurredAt: params.occurredAt,
    agentId: 'claude',
  }, {
    message: fallbackMessage,
    exitCode: params.exitCode,
    signal: params.signal,
  }, fallbackMessage);
}
