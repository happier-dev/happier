import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { WorkflowRunIdV1Schema } from '../workflows/workflowIdsV1.js';
import { ProviderAccountUsageRecordIdSchema } from '../connect/providerAccountUsagePrimitives.js';
import { ProviderAccountUsagePaceWindowV1Schema } from '../connect/deriveProviderAccountUsagePace.js';
import { UsageQuotaNotificationKindV1Schema } from '../account/settings/usagePacingPreferencesV1.js';
import { MachineVitalsDiskThresholdV1Schema } from '../machines/vitals/machineVitalsAlertsV1.js';
import { SessionGuardStateV1Schema, SessionGuardMemoryObservationV1Schema } from '../machines/guard/sessionGuardStateV1.js';
import { TerminalGuardStateV1Schema } from '../machines/guard/terminalGuardStateV1.js';
import { PUSH_NOTIFICATION_CATEGORY_IDS } from '../push/pushNotificationActions.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS } from '../actions/specs/machineTerminal.js';
import { FollowEventV1Schema } from '../sessions/follow/sessionFollowPolicyV1.js';
import { SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema } from '../sessions/follow/sessionFollowSourceOccurrenceV1.js';
import { ExecutionRunFollowSourceV1Schema, WorkflowRunFollowOriginalV1Schema, RunFollowOccurrenceV1Schema } from '../sessions/follow/sessionFollowInputV1.js';
import { DiscussionMessageRefV1Schema } from '../discussions/messageRefs.js';

const followUpdateFields = { event: z.lazy(() => FollowEventV1Schema) };
const FollowUpdateOriginalV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...followUpdateFields, sourceMessage: SessionFollowSourceMessageV1Schema, sourceRequests: z.optional(z.never()) }),
  z.strictObject({ ...followUpdateFields, sourceRequests: SessionFollowSourceRequestsV1Schema, sourceMessage: z.optional(z.never()) }),
]));
/** Content-free semantic notice; private rule definitions and source text never leave the executor. */
export const SessionFollowUpdateNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('follow_update'), sessionId: z.string().check(z.minLength(1)), follow: FollowUpdateOriginalV1Schema,
}));
export type SessionFollowUpdateNotificationV1 = z.infer<typeof SessionFollowUpdateNotificationV1Schema>;
/** Run notices carry their own retained original, never a parent Session occurrence. */
export const RunFollowUpdateNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('follow_update'), follow: RunFollowOccurrenceV1Schema,
}));
export type RunFollowUpdateNotificationV1 = z.infer<typeof RunFollowUpdateNotificationV1Schema>;
export const DiscussionFollowUpdateNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('follow_update'), follow: z.strictObject({ original: DiscussionMessageRefV1Schema,
    event: z.strictObject({ kind: z.enum(['person_wrote', 'message']) }) }),
}));
export type DiscussionFollowUpdateNotificationV1 = z.infer<typeof DiscussionFollowUpdateNotificationV1Schema>;
export const SourceFollowUpdateNotificationV1Schema = lazyZodSchema(() => z.union([
  RunFollowUpdateNotificationV1Schema, DiscussionFollowUpdateNotificationV1Schema,
]));

const UsageResetNotificationEvidenceV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderAccountUsagePaceWindowV1Schema, {
  observedAtMs: z.number().check(z.int(), z.nonnegative()), previousObservedAtMs: z.number().check(z.int(), z.nonnegative()),
  witnessedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
})));
const UsageWindowNotificationEvidenceV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(UsageResetNotificationEvidenceV1Schema, {
  usedFraction: z.number().check(z.nonnegative()), elapsedFraction: z.number().check(z.positive(), z.maximum(1)),
  pace: z.number().check(z.nonnegative()), projectedResetUtilizationFraction: z.number().check(z.nonnegative()),
  qualification: z.enum(['confirmed', 'estimated']), sampleCount: z.number().check(z.int(), z.positive()),
})));
const UsageCreditNotificationEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema, creditId: z.string().check(z.minLength(1)), expiresAtMs: z.number().check(z.int(), z.nonnegative()),
  observedAtMs: z.number().check(z.int(), z.nonnegative()), previousObservedAtMs: z.number().check(z.int(), z.nonnegative()),
}));
export const ConnectedServiceUsageNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('connected_service_usage'), kind: UsageQuotaNotificationKindV1Schema,
  serviceId: z.string().check(z.minLength(1)), profileId: z.string().check(z.minLength(1)), issueFingerprint: z.string().check(z.minLength(1)),
  evidence: z.union([UsageWindowNotificationEvidenceV1Schema, UsageResetNotificationEvidenceV1Schema, UsageCreditNotificationEvidenceV1Schema]),
}).check(z.superRefine((event, ctx) => {
  if ((event.kind === 'credit_expiry') !== ('creditId' in event.evidence)
    || (event.kind !== 'reset' && !('creditId' in event.evidence) && !('pace' in event.evidence))) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Evidence must match notification kind' });
  }
})));
export type ConnectedServiceUsageNotificationV1 = z.infer<typeof ConnectedServiceUsageNotificationV1Schema>;

/** Closed V1 evidence envelope; no process identities or private Session labels. */
export const MachineVitalsNotificationV1Schema = lazyZodSchema(() => {
  const common = {
    topic: z.literal('resource_limit'), phase: z.enum(['started', 'recovered']),
    machineId: z.string().check(z.minLength(1)), machineName: z.optional(z.string().check(z.minLength(1))),
    at: z.number().check(z.nonnegative()), since: z.number().check(z.nonnegative()),
    workingSessionCount: z.optional(z.number().check(z.int(), z.nonnegative())), guardEnabled: z.boolean(),
  };
  return z.discriminatedUnion('kind', [
    z.strictObject({ ...common, kind: z.literal('memory_pressure'), evidence: z.strictObject({
      level: z.enum(['elevated', 'critical']), sustainMs: z.number().check(z.positive()),
      swapUsedBytes: z.optional(z.number().check(z.nonnegative())), swapTotalBytes: z.optional(z.number().check(z.nonnegative())),
    }) }),
    z.strictObject({ ...common, kind: z.literal('cpu_busy'), evidence: z.strictObject({
      abovePct: z.number().check(z.minimum(1), z.maximum(100)), sustainMs: z.number().check(z.positive()),
      busyPct: z.number().check(z.minimum(0), z.maximum(100)),
    }) }),
    z.strictObject({ ...common, kind: z.literal('disk_nearly_full'), volumeId: z.string().check(z.minLength(1)),
      volumeLabel: z.optional(z.string()), evidence: z.strictObject({
        freeBytes: z.number().check(z.nonnegative()), totalBytes: z.number().check(z.nonnegative()),
        threshold: MachineVitalsDiskThresholdV1Schema,
      }) }),
  ]).check(z.refine(notice => notice.since <= notice.at, { path: ['since'], message: 'Evidence window starts after occurrence' }));
});
export type MachineVitalsNotificationV1 = z.infer<typeof MachineVitalsNotificationV1Schema>;

/** Closed routing envelope; the transport may add the known Home address. */
export const MachineVitalsPushRoutingDataV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('resource_limit'), kind: z.enum(['memory_pressure', 'disk_nearly_full', 'cpu_busy']),
  phase: z.enum(['started', 'recovered']), machineId: z.string().check(z.minLength(1)), notificationId: z.string().check(z.minLength(1)),
  nextSteps: z.array(z.enum(['review_processes', 'turn_on_guard', 'free_up_space'])),
  machineVitals: z.optional(MachineVitalsNotificationV1Schema),
  serverId: z.optional(z.string().check(z.minLength(1))), serverUrl: z.optional(z.string().check(z.url())),
}).check(z.superRefine((data, ctx) => {
  const notice = data.machineVitals;
  if (notice && (notice.machineId !== data.machineId || notice.kind !== data.kind || notice.phase !== data.phase)) {
    ctx.addIssue({ code: 'custom', path: ['machineVitals'], message: 'Notice must match routing identity' });
  }
})));
export type MachineVitalsPushRoutingDataV1 = z.infer<typeof MachineVitalsPushRoutingDataV1Schema>;

const guardWarningCommon = {
  topic: z.literal('guard_stop_warning'), machineId: z.string().check(z.minLength(1)),
  stopAt: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  idleMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
};
export const GuardStopWarningNotificationV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...guardWarningCommon, sessionId: z.string().check(z.minLength(1)), rule: z.enum(['idle_sessions', 'memory_guard']),
    // Words for the notification's own text only; never part of its routing data.
    sessionTitle: z.optional(z.string()), machineName: z.optional(z.string()) }),
  z.strictObject({ ...guardWarningCommon, terminalId: z.string().check(z.minLength(1)), terminalKey: z.string().check(z.minLength(1), z.maxLength(2000)),
    rule: z.literal('idle_terminals') }),
]));
export type GuardStopWarningNotificationV1 = z.infer<typeof GuardStopWarningNotificationV1Schema>;
export const GuardAttentionNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('guard_attention'), machineId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)),
  kind: z.enum(['ceiling_near', 'ceiling_reached']),
  memory: z.optional(SessionGuardMemoryObservationV1Schema),
}));
export type GuardAttentionNotificationV1 = z.infer<typeof GuardAttentionNotificationV1Schema>;

/** One occurrence identifier is reused by push, desktop and state-change dismissal. */
export function guardStopWarningNotificationIdV1(warning: GuardStopWarningNotificationV1): string {
  return warning.rule === 'idle_terminals'
    ? `guard-stop:terminal:${JSON.stringify([warning.machineId, warning.terminalKey, warning.terminalId, warning.stopAt])}`
    : `guard-stop:${warning.sessionId}:${warning.stopAt}`;
}

export function buildGuardStopWarningActionsV1(warning: GuardStopWarningNotificationV1) {
  return warning.rule === 'idle_terminals' ? {
    keepRunning: { actionId: 'machines.guard.idleStop.keepRunning' as const,
      input: { machineId: warning.machineId, terminalKey: warning.terminalKey } },
    stopNow: { actionId: 'machines.terminal.close' as const,
      input: { machineId: warning.machineId, terminalId: warning.terminalId } },
  } : {
    keepRunning: { actionId: 'machines.guard.idleStop.keepRunning' as const,
      input: { machineId: warning.machineId, sessionId: warning.sessionId } },
    stopNow: { actionId: 'session.stop' as const, input: { sessionId: warning.sessionId } },
  };
}

export function buildGuardStopWarningPushDataV1(event: GuardStopWarningNotificationV1) {
  const parsed = GuardStopWarningNotificationV1Schema.parse(event);
  const warning = parsed.rule === 'idle_terminals' ? parsed : (({ sessionTitle: _title, machineName: _machine, ...routing }) => routing)(parsed);
  return { ...warning, categoryId: PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1,
    notificationId: guardStopWarningNotificationIdV1(warning), actions: buildGuardStopWarningActionsV1(warning) };
}

const guardPushEnvelope = {
  categoryId: z.literal(PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1), notificationId: z.string().check(z.minLength(1)),
  serverId: z.optional(z.string().check(z.minLength(1))), serverUrl: z.optional(z.string().check(z.url())),
  actions: z.strictObject({
    keepRunning: z.strictObject({ actionId: z.literal('machines.guard.idleStop.keepRunning'),
      input: z.lazy(() => getActionSpec('machines.guard.idleStop.keepRunning').inputSchema) }),
    stopNow: z.union([
      z.strictObject({ actionId: z.literal('session.stop'), input: z.lazy(() => getActionSpec('session.stop').inputSchema) }),
      // Push carries a URL; its recipient resolves the device-local Home id before Action admission.
      z.strictObject({ actionId: z.literal('machines.terminal.close'),
        input: z.lazy(() => lazyZodSchema(() => z.omit(MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS['machines.terminal.close'], { serverId: true }))) }),
    ]),
  }),
};
export const GuardStopWarningPushDataV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...guardWarningCommon, ...guardPushEnvelope, sessionId: z.string().check(z.minLength(1)), rule: z.enum(['idle_sessions', 'memory_guard']) }),
  z.strictObject({ ...guardWarningCommon, ...guardPushEnvelope, terminalId: z.string().check(z.minLength(1)), terminalKey: z.string().check(z.minLength(1), z.maxLength(2000)), rule: z.literal('idle_terminals') }),
]).check(z.superRefine((data, context) => {
  const expected = buildGuardStopWarningActionsV1(data);
  if (data.notificationId !== guardStopWarningNotificationIdV1(data)
    || !sameStrictJsonValue(data.actions, expected)) {
    context.addIssue({ code: 'custom', message: 'Warning occurrence and actions must match the exact target' });
  }
})));
export type GuardStopWarningPushDataV1 = z.infer<typeof GuardStopWarningPushDataV1Schema>;

/** Home is already admitted from notification routing, never substituted from the active Home. */
export function readGuardStopWarningPushActionV1(data: unknown, action: 'keepRunning' | 'stopNow',
  home: Readonly<{ serverId: string }>) {
  const parsed = GuardStopWarningPushDataV1Schema.safeParse(data);
  if (!parsed.success) return null;
  const serverId = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS['machines.terminal.close'].shape.serverId.safeParse(home?.serverId);
  if (!serverId.success) return null;
  const target = buildGuardStopWarningActionsV1(parsed.data)[action];
  const qualified = { ...target, input: { ...target.input, serverId: serverId.data } };
  return getActionSpec(target.actionId).inputSchema.safeParse(qualified.input).success ? qualified : null;
}

/** Requires a successfully read current owner snapshot; absence here means cleared, not an unavailable read. */
export function isGuardStopWarningCurrentV1(data: unknown, current: Readonly<{
  machineId: string; sessionId?: string; terminalId?: string; terminalKey?: string; state: unknown;
}>): boolean {
  const parsed = GuardStopWarningPushDataV1Schema.safeParse(data);
  if (!parsed.success || parsed.data.machineId !== current.machineId) return false;
  const warning = parsed.data;
  const state = warning.rule === 'idle_terminals'
    ? TerminalGuardStateV1Schema.safeParse(current.state) : SessionGuardStateV1Schema.safeParse(current.state);
  return state.success && state.data.kind === 'stopping' && state.data.stopAt === warning.stopAt
    && state.data.rule === warning.rule && (warning.rule === 'idle_terminals'
      ? warning.terminalId === current.terminalId && warning.terminalKey === current.terminalKey
      : warning.sessionId === current.sessionId);
}

/** The public episode summary deliberately excludes private activity rows and subject labels. */
export const MachineGuardActivityNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('machine_guard_activity'), machineId: z.string().check(z.minLength(1)), episodeId: z.string().check(z.minLength(1)),
  freedBytes: z.number().check(z.nonnegative()), outOfSteps: z.boolean(),
  counts: z.strictObject({ stoppedSessions: z.number().check(z.int(), z.nonnegative()), closedBrowsers: z.number().check(z.int(), z.nonnegative()),
    stoppedServices: z.number().check(z.int(), z.nonnegative()), stoppedLeftBehind: z.number().check(z.int(), z.nonnegative()) }),
}));
export type MachineGuardActivityNotificationV1 = z.infer<typeof MachineGuardActivityNotificationV1Schema>;

export const ActivityWebhookTopicSchema = lazyZodSchema(() => z.enum([
  'follow_update',
  'ready',
  'permission_request',
  'user_action_request',
  'connected_service_account_switch',
  'connected_service_credential_health',
  'connected_service_quota_blocked',
  'connected_service_quota_recovered',
  'connected_service_usage',
  'workflow_run_update',
  'notify_me',
  'guard_stop_warning',
  'guard_attention',
  'machine_guard_activity',
  'resource_limit',
  'service_health',
]));

export type ActivityWebhookTopic = z.infer<typeof ActivityWebhookTopicSchema>;

export const WorkflowRunUpdateKindV1Schema = lazyZodSchema(() => z.enum([
  'completed',
  'completed_with_failures',
  'failed',
  'outcome_uncertain',
  'paused',
  'interrupted',
  'review_required',
]));
export type WorkflowRunUpdateKindV1 = z.infer<typeof WorkflowRunUpdateKindV1Schema>;

/**
 * Safe outbound reason projection. Only the machine-readable code crosses the
 * notification boundary; private messages and diagnostics remain in Run detail.
 */
export const WorkflowRunUpdateReasonV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.string().check(z.minLength(1)),
}));
export type WorkflowRunUpdateReasonV1 = z.infer<typeof WorkflowRunUpdateReasonV1Schema>;

export const WorkflowRunUpdateNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('workflow_run_update'),
  runId: WorkflowRunIdV1Schema,
  updateKind: WorkflowRunUpdateKindV1Schema,
  reason: z.optional(WorkflowRunUpdateReasonV1Schema),
}));
export type WorkflowRunUpdateNotificationV1 = z.infer<typeof WorkflowRunUpdateNotificationV1Schema>;

const ActivityWebhookContentV1Schema = lazyZodSchema(() => z.object({
  title: z.string(),
  body: z.string(),
}));

const WorkflowActivityWebhookContentV1Schema = lazyZodSchema(() => z.strictObject({
  title: z.string(),
  body: z.string(),
}));

const ActivityWebhookSessionV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  title: z.optional(z.nullable(z.string())),
}));

const ActivityWebhookRequestV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().check(z.trim(), z.minLength(1)),
  kind: z.enum(['permission', 'user_action']),
  toolName: z.string().check(z.trim(), z.minLength(1)),
  toolDetails: z.optional(z.nullable(z.string())),
}));

const ActivityWebhookOrdinaryTopicSchema = lazyZodSchema(() => z.enum(ActivityWebhookTopicSchema.options.filter((value): value is Exclude<(typeof ActivityWebhookTopicSchema.options)[number], 'workflow_run_update' | 'follow_update'> => !(['workflow_run_update', 'follow_update'] as readonly string[]).includes(value))));

const ActivityWebhookOrdinaryPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z._default(z.literal(1), 1),
  channelId: z.string().check(z.trim(), z.minLength(1)),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  topic: ActivityWebhookOrdinaryTopicSchema,
  content: ActivityWebhookContentV1Schema,
  session: z.optional(ActivityWebhookSessionV1Schema),
  request: z.optional(ActivityWebhookRequestV1Schema),
  metadata: z.optional(z.record(z.string(), z.unknown())),
  navigation: z.object({
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    requestId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    runId: z.optional(WorkflowRunIdV1Schema),
  }),
}));

export const WorkflowRunUpdateWebhookPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z._default(z.literal(1), 1),
  channelId: z.string().check(z.trim(), z.minLength(1)),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  topic: z.literal('workflow_run_update'),
  content: WorkflowActivityWebhookContentV1Schema,
  workflowRun: z.omit(WorkflowRunUpdateNotificationV1Schema, { topic: true }),
  navigation: z.strictObject({
    runId: WorkflowRunIdV1Schema,
  }),
}));

export const ActivityWebhookPayloadV1Schema = lazyZodSchema(() => z.discriminatedUnion('topic', [
  ActivityWebhookOrdinaryPayloadV1Schema,
  WorkflowRunUpdateWebhookPayloadV1Schema,
  z.strictObject({ v: z._default(z.literal(1), 1), channelId: z.string().check(z.trim(), z.minLength(1)),
    createdAt: z.number().check(z.int(), z.nonnegative()), topic: z.literal('follow_update'),
    content: WorkflowActivityWebhookContentV1Schema,
    follow: z.union([FollowUpdateOriginalV1Schema, RunFollowUpdateNotificationV1Schema.shape.follow,
      DiscussionFollowUpdateNotificationV1Schema.shape.follow]),
    navigation: z.union([z.strictObject({ sessionId: z.string().check(z.minLength(1)) }),
      z.strictObject({ message: DiscussionMessageRefV1Schema }),
      z.strictObject({ source: z.union([ExecutionRunFollowSourceV1Schema, WorkflowRunFollowOriginalV1Schema.shape.source]) })]),
  }).check(z.superRefine((payload, ctx) => {
    if ('original' in payload.follow ? 'kind' in payload.follow.original
      ? !('message' in payload.navigation) || !sameStrictJsonValue(payload.follow.original, payload.navigation.message)
      : !('source' in payload.navigation) || !sameStrictJsonValue(payload.follow.original.source, payload.navigation.source)
      : !('sessionId' in payload.navigation)) {
      ctx.addIssue({ code: 'custom', path: ['navigation'], message: 'Navigation must match the Follow original' });
    }
  })),
]));

export type ActivityWebhookPayloadV1 = z.infer<typeof ActivityWebhookPayloadV1Schema>;

export function buildActivityWebhookPayload(params: Readonly<{
  channelId: string;
  createdAt: number;
  topic: ActivityWebhookTopic;
  content: Readonly<{ title: string; body: string }>;
  session?: Readonly<{ sessionId: string; title?: string | null }> | null;
  request?: Readonly<{
    requestId: string;
    kind: 'permission' | 'user_action';
    toolName: string;
    toolDetails?: string | null;
  }> | null;
  workflowRun?: Readonly<{
    runId: string;
    updateKind: WorkflowRunUpdateKindV1;
    reason?: WorkflowRunUpdateReasonV1;
  }> | null;
  metadata?: Readonly<Record<string, unknown>> | undefined;
  notificationOpen?: Readonly<{ kind: 'session'; sessionId: string }> | Readonly<{ kind: 'workflow_run'; runId: string }>;
  follow?: SessionFollowUpdateNotificationV1['follow'] | RunFollowUpdateNotificationV1['follow'] | DiscussionFollowUpdateNotificationV1['follow'];
}>): ActivityWebhookPayloadV1 {
  const common = {
    v: 1,
    channelId: params.channelId,
    createdAt: params.createdAt,
    topic: params.topic,
    content: {
      title: params.content.title,
      body: params.content.body,
    },
  } as const;
  if (params.topic === 'follow_update') {
    return ActivityWebhookPayloadV1Schema.parse({ ...common, follow: params.follow,
      navigation: params.follow && 'original' in params.follow ? 'kind' in params.follow.original
        ? { message: params.follow.original } : { source: params.follow.original.source }
        : { sessionId: params.session?.sessionId } });
  }
  if (params.topic === 'workflow_run_update') {
    return ActivityWebhookPayloadV1Schema.parse({
      ...common,
      workflowRun: params.workflowRun,
      navigation: { runId: params.workflowRun?.runId },
    });
  }
  return ActivityWebhookPayloadV1Schema.parse({
    ...common,
    session: params.session
      ? {
        sessionId: params.session.sessionId,
        title: params.session.title ?? null,
      }
      : undefined,
    request: params.request
      ? {
        requestId: params.request.requestId,
        kind: params.request.kind,
        toolName: params.request.toolName,
        toolDetails: params.request.toolDetails ?? null,
      }
      : undefined,
    metadata: params.metadata,
    navigation: {
      sessionId: params.session?.sessionId,
      requestId: params.request?.requestId,
      ...(params.topic === 'notify_me' && params.notificationOpen?.kind === 'session'
        ? { sessionId: params.notificationOpen.sessionId } : {}),
      ...(params.topic === 'notify_me' && params.notificationOpen?.kind === 'workflow_run'
        ? { runId: params.notificationOpen.runId } : {}),
    },
  });
}
