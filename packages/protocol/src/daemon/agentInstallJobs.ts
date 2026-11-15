import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';

// Development install-job operation, independent of the package version. Every
// envelope is closed: caller-supplied commands and consent extensions are rejected.
// Acquire intents are the install-job intents minus 'uninstall'; one list feeds both enums.
const AGENT_ACQUIRE_JOB_INTENTS = ['install', 'update'] as const;
export const AgentInstallJobIntentSchema = lazyZodSchema(() => z.enum([...AGENT_ACQUIRE_JOB_INTENTS, 'uninstall']));
export const AgentAcquireJobIntentSchema = lazyZodSchema(() => z.enum(AGENT_ACQUIRE_JOB_INTENTS));
export const AgentInstallJobConsentSchema = lazyZodSchema(() => z.strictObject({ vendorRecipe: z.boolean() }));
export const AgentInstallJobStepSchema = lazyZodSchema(() => z.strictObject({
  stepId: z.string().check(z.minLength(1)),
  label: z.string().check(z.minLength(1)),
  state: z.enum(['running', 'done', 'failed']),
}));
/**
 * The job's own step ids: the Agent's CLI (one per Agent or configured definition) and the final check
 * that it runs. Every other step is a dependency. Presenters map their setup rows by these ids.
 */
export function buildAgentInstallJobCliStepId(target: Readonly<{ agentId: string; definitionId?: string }>): string {
  return target.definitionId === undefined ? `cli.${target.agentId}` : `cli.${target.agentId}.${target.definitionId}`;
}
export const AGENT_INSTALL_JOB_VERIFY_STEP_ID = 'verify';
export const AgentInstallJobProgressSchema = lazyZodSchema(() => z.strictObject({
  stepId: z.string().check(z.minLength(1)),
  bytesDone: z.number().check(z.int(), z.nonnegative()),
  bytesTotal: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));
export const AgentInstallJobFailureCodeSchema = lazyZodSchema(() => z.enum([
  'consent_required', 'unsupported_platform', 'install_not_available',
  'archive_expanded_byte_limit', 'download_failed', 'rate_limited', 'verification_failed', 'timeout', 'cancelled',
  'install_failed', 'update_not_available', 'not_managed', 'in_use',
]));
export const AgentInstallJobOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('succeeded'), version: z.nullable(z.string()),
    checksum: z.optional(z.enum(['verified', 'not_published'])) }),
  z.strictObject({
    kind: z.literal('failed'),
    code: AgentInstallJobFailureCodeSchema,
    stepId: z.string().check(z.minLength(1)),
    message: z.string().check(z.minLength(1)),
    guideUrl: z.optional(z.string().check(z.url())),
    failureCause: z.optional(ActionFailureCauseV1Schema),
  }),
]));
export const AgentInstallJobEventSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.extend(AgentInstallJobStepSchema, { t: z.literal('step') }),
  z.extend(AgentInstallJobProgressSchema, { t: z.literal('progress') }),
  z.strictObject({ t: z.literal('log'), line: z.string() }),
]));
export const AgentInstallJobSchema = lazyZodSchema(() => z.strictObject({
  jobId: z.string().check(z.minLength(1)),
  agentId: z.string().check(z.minLength(1)),
  definitionId: z.optional(z.string().check(z.minLength(1))),
  intent: AgentInstallJobIntentSchema,
  executionScope: z.optional(z.enum(['machine', 'member'])),
  startedAt: z.number().check(z.int(), z.nonnegative()),
  steps: z.array(AgentInstallJobStepSchema),
  progress: z.array(AgentInstallJobProgressSchema),
  done: z.boolean(),
  outcome: z.nullable(AgentInstallJobOutcomeSchema),
}));
export const DaemonAgentInstallErrorSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: z.enum(['invalid_request', 'job_not_found', 'install_unavailable', 'member_install_unavailable', 'not_managed', 'in_use', 'definition_version_changed']),
  error: z.string().check(z.minLength(1)),
}));
export const DaemonAgentInstallStartRequestSchema = lazyZodSchema(() => z.strictObject({
  agentId: z.string().check(z.minLength(1)),
  definitionId: z.optional(z.string().check(z.minLength(1))),
  /** Private registry-install precondition; the daemon still owns the executable declaration. */
  expectedDefinitionVersion: z.optional(z.string().check(z.minLength(1))),
  intent: AgentInstallJobIntentSchema,
  consent: AgentInstallJobConsentSchema,
  force: z.optional(z.boolean()),
}));
export const DaemonAgentInstallStartResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), jobId: z.string().check(z.minLength(1)),
    executionScope: AgentInstallJobSchema.shape.executionScope }),
  DaemonAgentInstallErrorSchema,
]));
export const DaemonAgentInstallReadRequestSchema = lazyZodSchema(() => z.strictObject({
  jobId: z.string().check(z.minLength(1)), cursor: z.number().check(z.int(), z.nonnegative()),
  waitForTerminal: z.optional(z.boolean()),
}));
export const DaemonAgentInstallReadResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true), events: z.array(AgentInstallJobEventSchema),
    steps: AgentInstallJobSchema.shape.steps,
    progress: AgentInstallJobSchema.shape.progress,
    nextCursor: z.number().check(z.int(), z.nonnegative()), done: z.boolean(),
    outcome: z.nullable(AgentInstallJobOutcomeSchema),
  }),
  DaemonAgentInstallErrorSchema,
]));
export const DaemonAgentInstallCancelRequestSchema = lazyZodSchema(() => z.strictObject({ jobId: z.string().check(z.minLength(1)) }));
export const DaemonAgentInstallCancelResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true) }), DaemonAgentInstallErrorSchema,
]));
export const DaemonAgentInstallListRequestSchema = lazyZodSchema(() => z.strictObject({}));
export const DaemonAgentInstallListResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), jobs: z.array(AgentInstallJobSchema) }), DaemonAgentInstallErrorSchema,
]));

export type AgentInstallJobIntent = z.infer<typeof AgentInstallJobIntentSchema>;
export type AgentInstallJobConsent = z.infer<typeof AgentInstallJobConsentSchema>;
export type AgentInstallJobStep = z.infer<typeof AgentInstallJobStepSchema>;
export type AgentInstallJobProgress = z.infer<typeof AgentInstallJobProgressSchema>;
export type AgentInstallJobFailureCode = z.infer<typeof AgentInstallJobFailureCodeSchema>;
export type AgentInstallJobOutcome = z.infer<typeof AgentInstallJobOutcomeSchema>;
export type AgentInstallJobEvent = z.infer<typeof AgentInstallJobEventSchema>;
export type AgentInstallJob = z.infer<typeof AgentInstallJobSchema>;
export type DaemonAgentInstallError = z.infer<typeof DaemonAgentInstallErrorSchema>;
export type DaemonAgentInstallStartRequest = z.infer<typeof DaemonAgentInstallStartRequestSchema>;
export type DaemonAgentInstallStartResponse = z.infer<typeof DaemonAgentInstallStartResponseSchema>;
export type DaemonAgentInstallReadRequest = z.infer<typeof DaemonAgentInstallReadRequestSchema>;
export type DaemonAgentInstallReadResponse = z.infer<typeof DaemonAgentInstallReadResponseSchema>;
export type DaemonAgentInstallCancelRequest = z.infer<typeof DaemonAgentInstallCancelRequestSchema>;
export type DaemonAgentInstallCancelResponse = z.infer<typeof DaemonAgentInstallCancelResponseSchema>;
export type DaemonAgentInstallListRequest = z.infer<typeof DaemonAgentInstallListRequestSchema>;
export type DaemonAgentInstallListResponse = z.infer<typeof DaemonAgentInstallListResponseSchema>;
