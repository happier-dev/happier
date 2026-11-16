import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ActionRefusalDiagnosticV1Schema } from '../../actions/actionRefusalDiagnostic.js';
import { DeploymentBackupRunInputV1Schema } from '../../deployments/deploymentBackupActionsV1.js';
import { WorkflowDefinitionSavedByV1Schema } from '../workflowDefinitionV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { WorkflowDestinationsV1Schema } from '../workflowDestinationsV1.js';
import { AutomationTriggerDefinitionInputSchema, AutomationTriggerDefinitionSchema, AutomationPluginEventDefinitionTriggerSchema } from '../../automations/automationTriggerDefinition.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import { AutomationIdV1Schema } from '../../automations/automationIdV1.js';
import { AutomationManualIdempotencyKeyV1Schema } from '../../automations/automationOccurrenceV1.js';
import { AutomationTriggerDetailSchema, AutomationScheduleTriggerProjectionSchema,
  AutomationPluginEventTriggerProjectionSchema, AutomationSessionLifecycleTriggerProjectionSchema,
  AutomationActionTriggerProjectionSchema,
  AutomationCheckpointedPullObservationSchema } from '../../automations/automationTriggerProjectionV1.js';
import { AutomationRunLifecycleTriggerSchema } from '../../automations/automationRunLifecycle.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationDeploymentTriggerFilterV1Schema, AutomationManagedTargetV1Schema, AutomationObservationOnlyDefinitionV1Schema, AutomationStoredWorkflowDefinitionV2Schema } from '../../automations/automationWorkflowRecipeV2.js';
import { WorkflowProjectTargetV1Schema } from '../workflowWorkspaceV1.js';
import { WorkflowDefinitionRefV1StringSchema } from '../workflowDefinitionRefV1.js';
import { TriggerTargetV1Schema } from './triggerTargetV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { AutomationPullRequestTriggerSchema } from '../../automations/pullRequestTrigger.js';
import { AutomationSessionLifecyclePolicySchema } from '../../automations/automationSessionLifecycle.js';
import { AutomationEventTriggerDefinitionStoredPayloadV1Schema } from '../../automations/automationEventV1.js';
import { ScmHostingProviderKindSchema } from '../../scm/pullRequests.js';
import { HealthCheckSubjectV1Schema } from '../../deployments/healthCheckSubjectV1.js';
import { HealthCheckSourceConfigV1Schema } from '../../deployments/healthCheckSourceV1.js';
import { AutomationEventSourceInstanceIdV1Schema } from '../../automations/automationEventJsonBoundsV1.js';
import { AutomationActionTriggerSchema } from '../../automations/automationActionTriggerV1.js';

const Revision = z.number().check(z.int(), z.nonnegative(), z.int());
/** Only public list-safe inputs consumed by the shared human-readable trigger summary. */
export const WorkflowTriggerSummaryInputV1Schema = lazyZodSchema(() => {
  const historyIdentity = {
    automationId: zMini.optional(asProtocolZod(AutomationIdV1Schema)),
    triggerId: zMini.optional(AutomationTriggerIdSchema),
    /** False when the trigger or its set is off, so every summary says Off where its detail does; older summaries omit it. */
    enabled: zMini.optional(z.boolean()),
  };
  return z.discriminatedUnion('kind', [
    zMini.extend(zMini.pick(AutomationActionTriggerProjectionSchema, { kind: true, phase: true, actionIds: true,
      subjectKind: true, subjectKey: true, mode: true, onFailure: true }), historyIdentity),
    zMini.extend(zMini.pick(AutomationScheduleTriggerProjectionSchema, { kind: true, schedule: true }), {
      ...historyIdentity,
      /** Exact enabled occurrence from the scheduler; older summaries omit it. */
      nextRunAt: zMini.optional(AutomationScheduleTriggerProjectionSchema.shape.nextRunAt),
      remainingOccurrences: AutomationScheduleTriggerProjectionSchema.shape.remainingOccurrences,
    }),
    zMini.extend(zMini.pick(AutomationPluginEventTriggerProjectionSchema, { kind: true, eventRef: true }), historyIdentity),
    zMini.extend(zMini.pick(AutomationSessionLifecycleTriggerProjectionSchema, { kind: true, events: true }), historyIdentity),
    zMini.extend(zMini.pick(AutomationRunLifecycleTriggerSchema, { kind: true, condition: true }), historyIdentity),
    z.strictObject({ kind: z.literal('prComment'), ...historyIdentity }),
    z.strictObject({ kind: z.literal('ciFailed'), ...historyIdentity }),
  ]);
});
export type WorkflowTriggerSummaryInputV1 = z.infer<typeof WorkflowTriggerSummaryInputV1Schema>;
/** Intended Event membership needs only its current declaration locator, never private source configuration. */
export const WorkflowIntendedPluginEventV1Schema = lazyZodSchema(() => z.pick(AutomationPluginEventDefinitionTriggerSchema, {
  kind: true, eventRef: true, observationTransport: true,
}));
export type WorkflowIntendedPluginEventV1 = z.infer<typeof WorkflowIntendedPluginEventV1Schema>;
/** Stored rows retain their identity; pending Event rows carry the declaration's source locator. */
export const WorkflowIntendedTriggerV1Schema = lazyZodSchema(() => z.union([
  WorkflowTriggerSummaryInputV1Schema, WorkflowIntendedPluginEventV1Schema,
]));
export type WorkflowIntendedTriggerV1 = z.infer<typeof WorkflowIntendedTriggerV1Schema>;
export const WorkflowTriggerSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  workflowDefinitionId: WorkflowDefinitionRefV1StringSchema,
  triggers: z.array(WorkflowTriggerSummaryInputV1Schema),
  nextRunAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));
export type WorkflowTriggerSummaryV1 = z.infer<typeof WorkflowTriggerSummaryV1Schema>;

/** Both owned and Team projections consume the scheduler's next time, never recompute it. */
export function summarizeWorkflowTriggerRowsV1(rows: readonly Readonly<{
  id: string; workflowDefinitionId?: string | null; enabled: boolean;
  triggers: readonly import('../../automations/automationTriggerProjectionV1.js').AutomationTriggerListItem[];
}>[]): Map<string, WorkflowTriggerSummaryV1> {
  const result = new Map<string, WorkflowTriggerSummaryV1>();
  for (const row of rows) {
    if (!row.workflowDefinitionId) continue;
    const summary = result.get(row.workflowDefinitionId) ?? { workflowDefinitionId: row.workflowDefinitionId, triggers: [], nextRunAt: null };
    for (const trigger of row.triggers) {
      const historyIdentity = { automationId: row.id, triggerId: trigger.id, enabled: row.enabled && trigger.enabled };
      switch (trigger.kind) {
        case 'action': {
          if ('consentFor' in trigger) break;
          summary.triggers.push({ ...historyIdentity, kind: trigger.kind, phase: trigger.phase, actionIds: trigger.actionIds,
            ...(trigger.subjectKind === undefined ? {} : { subjectKind: trigger.subjectKind, subjectKey: trigger.subjectKey }),
            ...(trigger.mode === undefined ? {} : { mode: trigger.mode }),
            ...(trigger.onFailure === undefined ? {} : { onFailure: trigger.onFailure }) });
          break;
        }
        case 'schedule': {
          const nextRunAt = row.enabled && trigger.enabled ? trigger.nextRunAt : null;
          summary.triggers.push({ ...historyIdentity, kind: trigger.kind, schedule: trigger.schedule, nextRunAt,
            ...(trigger.remainingOccurrences === undefined ? {} : { remainingOccurrences: trigger.remainingOccurrences }) });
          if (nextRunAt !== null) summary.nextRunAt = summary.nextRunAt === null ? nextRunAt : Math.min(summary.nextRunAt, nextRunAt);
          break;
        }
        case 'pluginEvent': summary.triggers.push({ ...historyIdentity, kind: trigger.kind, eventRef: trigger.eventRef }); break;
        case 'sessionLifecycle': summary.triggers.push({ ...historyIdentity, kind: trigger.kind, events: trigger.events }); break;
        case 'runLifecycle': summary.triggers.push({ ...historyIdentity, kind: trigger.kind, condition: trigger.condition }); break;
        case 'prComment': case 'ciFailed': summary.triggers.push({ ...historyIdentity, kind: trigger.kind }); break;
      }
    }
    result.set(row.workflowDefinitionId, summary);
  }
  return result;
}
const ContextFields = lazyZodSchema(() => zMini.omit(AutomationStoredWorkflowDefinitionV2Schema, { workspace: true, inlineDefinition: true, onComplete: true, deploymentTriggers: true, actionApprovals: true }));
/** A policy-independent capture identity; Environment edits do not rewrite a saved Workflow's target. */
export const WorkflowDeploymentBackupTargetV1Schema = lazyZodSchema(() => z.omit(DeploymentBackupRunInputV1Schema, { expectedRevision: true }));
export const WorkflowTriggerListRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ workflow: WorkflowDefinitionRefV1StringSchema }),
  z.strictObject({ managedTarget: AutomationManagedTargetV1Schema }),
  z.strictObject({ deploymentBackup: WorkflowDeploymentBackupTargetV1Schema }),
  z.strictObject({ backupFreshness: z.strictObject({ automationId: asProtocolZod(AutomationIdV1Schema) }) }),
  z.strictObject({ deploymentBackupEnvironment: z.strictObject({
    serverId: WorkflowDeploymentBackupTargetV1Schema.shape.serverId,
    environmentId: WorkflowDeploymentBackupTargetV1Schema.shape.environmentId,
  }) }),
  z.strictObject({ healthSource: z.strictObject({ sourceInstanceIds: z.array(AutomationEventSourceInstanceIdV1Schema) }) }),
  z.strictObject({ scope: z.enum(['account_inline', 'account_all', 'account_source_unavailable']) }),
  z.strictObject({ automationId: asProtocolZod(AutomationIdV1Schema), review: z.literal(true) }),
  z.strictObject({ automationId: asProtocolZod(AutomationIdV1Schema), triggerId: AutomationTriggerIdSchema }),
]));
const WorkflowTriggerExecutableAddRequestV1Schema = lazyZodSchema(() => z.strictObject({
  workflow: zMini.optional(WorkflowDefinitionRefV1StringSchema),
  target: zMini.optional(TriggerTargetV1Schema),
  project: WorkflowProjectTargetV1Schema,
  observationOnly: z.optional(z.never()),
  ...zMini.partial(ContextFields).shape,
  trigger: AutomationTriggerDefinitionInputSchema,
  deployment: z.optional(AutomationDeploymentTriggerFilterV1Schema),
  actionApproval: z.optional(z.enum(['automatic', 'ask'])),
}).check(z.superRefine((value, ctx) => {
  if ((value.workflow === undefined) === (value.target === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'Choose exactly one workflow or target' });
  }
  if (value.target?.kind === 'inline' && value.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Inline triggers are private' });
  }
})));
export const WorkflowTriggerAddRequestV1Schema = lazyZodSchema(() => z.union([
  WorkflowTriggerExecutableAddRequestV1Schema,
  z.strictObject({
    observationOnly: z.omit(AutomationObservationOnlyDefinitionV1Schema, { templateVersion: true }),
    /** Return the retained private Event definition, including when enrollment rejoins an existing source. */
    includeEventDefinition: z.optional(z.literal(true)),
    name: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    trigger: AutomationTriggerDefinitionInputSchema,
    workflow: z.optional(z.never()), target: z.optional(z.never()), project: z.optional(z.never()),
  }).check(z.refine(value => value.trigger.kind === 'pluginEvent', 'Observation-only definitions require an Event source')),
]));
export const WorkflowTriggerUpdateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: zMini.optional(AutomationTriggerIdSchema),
  expectedRevision: Revision,
  confirmLegacyConversion: z.optional(z.literal(true)),
  patch: z.strictObject({
    project: zMini.optional(WorkflowProjectTargetV1Schema),
    ...zMini.partial(ContextFields).shape,
    target: zMini.optional(TriggerTargetV1Schema),
    enabled: z.optional(z.boolean()),
    trigger: zMini.optional(AutomationTriggerDefinitionSchema),
    deployment: z.optional(z.nullable(AutomationDeploymentTriggerFilterV1Schema)),
    actionApproval: z.optional(z.enum(['automatic', 'ask'])),
  }).check(z.refine((patch) => Object.keys(patch).length > 0, 'A trigger update needs a change')),
}).check(z.superRefine((value, ctx) => {
  if (value.patch.trigger !== undefined && value.triggerId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['triggerId'], message: 'A trigger definition update needs its trigger id' });
  }
  if ((value.patch.deployment !== undefined || value.patch.actionApproval !== undefined) && value.triggerId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['triggerId'], message: 'Deployment routing requires its trigger id' });
  }
  if (value.patch.target?.kind === 'inline' && value.patch.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['patch', 'visibleTeamId'], message: 'Inline triggers are private' });
  }
})));
export const WorkflowTriggerRemoveRequestV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  /** Omission removes the Account trigger set; a child id removes only that trigger. */
  triggerId: zMini.optional(AutomationTriggerIdSchema),
}));
/** Admits the retained Automation's manual occurrence; it does not edit or convert the definition. */
export const WorkflowTriggerRunNowRequestV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  idempotencyKey: zMini.optional(AutomationManualIdempotencyKeyV1Schema),
}));
const OpenedPullRequestTriggerDetailSchema = lazyZodSchema(() => z.strictObject({
  id: AutomationTriggerIdSchema, revision: Revision, enabled: z.boolean(),
  createdAt: z.number().check(z.int(), z.nonnegative(), z.int()), updatedAt: z.number().check(z.int(), z.nonnegative(), z.int()),
  sourceSessionId: asProtocolZod(SessionIdSchema), triggerDefinitionEnvelope: z.string().check(z.minLength(1)),
  ...AutomationPullRequestTriggerSchema.shape,
}));
const OpenedActionTriggerDetailSchema = lazyZodSchema(() => z.extend(AutomationActionTriggerSchema,
  z.pick(AutomationActionTriggerProjectionSchema, {
    id: true, revision: true, enabled: true, createdAt: true, updatedAt: true,
  }).shape));
export const WorkflowTriggerSetV1Schema = lazyZodSchema(() => z.strictObject({
  /** Display facts from the already-admitted Account record, not another lookup. */
  name: z.optional(z.string()),
  updatedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  /** Read-time fact from the saved scheduler cursor and the actual latest started Run. */
  missedSchedules: z.optional(z.array(z.strictObject({ triggerId: AutomationTriggerIdSchema,
    dueAt: z.number().check(z.int(), z.nonnegative()), lastRunAt: z.nullable(z.number().check(z.int(), z.nonnegative())) }))),
  /** Current saved definition provenance, never an occurrence's accepted source. Display only. */
  sourceSavedBy: z.optional(WorkflowDefinitionSavedByV1Schema),
  sourceSavedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  automationId: asProtocolZod(AutomationIdV1Schema), revision: Revision, enabled: z.boolean(),
  scopeSessionId: zMini.optional(zMini.nullable(asProtocolZod(SessionIdSchema))),
  health: z.enum(['available', 'source_unavailable']),
  observationOnly: z.optional(AutomationObservationOnlyDefinitionV1Schema),
  legacy: z.optional(z.strictObject({ editable: z.literal(false), reason: z.literal('created_in_0_2'),
    lockedReason: z.optional(z.enum(['session_key_required', 'migration_required', 'decryption_failed', 'review_required'])),
    placements: z.optional(z.array(zMini.pick(WorkflowProjectTargetV1Schema, { machineId: true, directory: true }))),
  })),
  target: zMini.optional(TriggerTargetV1Schema),
  project: zMini.optional(WorkflowProjectTargetV1Schema),
  context: zMini.optional(AutomationStoredWorkflowDefinitionV2Schema),
  destinations: zMini.optional(WorkflowDestinationsV1Schema),
  /** Current enabled assignments; plural/empty predecessor placement is preserved on conversion. */
  placements: z.optional(z.array(zMini.pick(WorkflowProjectTargetV1Schema, { machineId: true, directory: true }))),
  triggers: z.array(z.union([
    AutomationTriggerDetailSchema._zod.def.options[2],
    zMini.extend(AutomationTriggerDetailSchema._zod.def.options[3], {
      /** Private source owner projection, independent of execution placement and Environment lifecycle. */
      subject: z.optional(HealthCheckSubjectV1Schema),
    }),
    AutomationTriggerDetailSchema._zod.def.options[4], AutomationTriggerDetailSchema._zod.def.options[5],
    OpenedPullRequestTriggerDetailSchema,
    OpenedActionTriggerDetailSchema, AutomationTriggerDetailSchema._zod.def.options[7],
  ])),
}));
const WorkflowTriggerEventDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  triggerId: AutomationTriggerIdSchema, definition: AutomationEventTriggerDefinitionStoredPayloadV1Schema,
}));
/** Saved health configuration and its observer are one private source-owner answer. */
export const WorkflowTriggerHealthSourceV1Schema = lazyZodSchema(() => z.strictObject({
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  revision: z.string().check(z.minLength(1)),
  source: HealthCheckSourceConfigV1Schema,
  enabled: z.boolean(),
  observer: AutomationCheckpointedPullObservationSchema.shape.watcher,
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
}));
export type WorkflowTriggerHealthSourceV1 = z.infer<typeof WorkflowTriggerHealthSourceV1Schema>;
export const WorkflowTriggerListResultV1Schema = lazyZodSchema(() => z.strictObject({
  sets: z.array(WorkflowTriggerSetV1Schema), triggerDefinition: z.optional(WorkflowTriggerEventDefinitionV1Schema),
  healthSources: z.optional(z.array(WorkflowTriggerHealthSourceV1Schema)),
  backupEnvironments: z.optional(z.array(z.strictObject({
    serverId: WorkflowDeploymentBackupTargetV1Schema.shape.serverId,
    environmentId: WorkflowDeploymentBackupTargetV1Schema.shape.environmentId,
  }))),
}));
export const WorkflowTriggerWriteResultV1Schema = lazyZodSchema(() => z.strictObject({
  set: WorkflowTriggerSetV1Schema,
  triggerId: zMini.optional(AutomationTriggerIdSchema),
  triggerRevision: z.optional(Revision),
  triggerDefinition: z.optional(WorkflowTriggerEventDefinitionV1Schema),
}));
export const WorkflowTriggerRemoveResultV1Schema = lazyZodSchema(() => z.union([
  WorkflowTriggerWriteResultV1Schema,
  z.strictObject({ automationId: asProtocolZod(AutomationIdV1Schema), deleted: z.literal(true),
    removedRevision: z.optional(Revision) }),
]));
export type WorkflowTriggerListRequestV1 = z.infer<typeof WorkflowTriggerListRequestV1Schema>;
export type WorkflowTriggerAddRequestV1 = z.infer<typeof WorkflowTriggerAddRequestV1Schema>;
export type WorkflowTriggerUpdateRequestV1 = z.infer<typeof WorkflowTriggerUpdateRequestV1Schema>;
export type WorkflowTriggerRemoveRequestV1 = z.infer<typeof WorkflowTriggerRemoveRequestV1Schema>;
export type WorkflowTriggerRunNowRequestV1 = z.infer<typeof WorkflowTriggerRunNowRequestV1Schema>;
export type WorkflowTriggerSetV1 = z.infer<typeof WorkflowTriggerSetV1Schema>;

/** Unavailable saved sources retain their Account cleanup path; legacy copies keep their own review flow. */
export function isWorkflowTriggerSourceGoneV1(set: Pick<WorkflowTriggerSetV1, 'health' | 'legacy'>): boolean {
  return set.health === 'source_unavailable' && set.legacy === undefined;
}

const SessionId = asProtocolZod(SessionIdSchema);
const SessionContextFields = lazyZodSchema(() => zMini.omit(AutomationStoredWorkflowDefinitionV2Schema, { workspace: true, inlineDefinition: true, deploymentTriggers: true, actionApprovals: true }));
const SessionPullRequestTriggerSchema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(AutomationPullRequestTriggerSchema, {
  pullRequest: zMini.optional(AutomationPullRequestTriggerSchema.shape.pullRequest),
})));
export const SessionTriggerDefinitionV1Schema = lazyZodSchema(() => z.union([AutomationTriggerDefinitionSchema, SessionPullRequestTriggerSchema]));
export const SessionTriggerDefinitionInputV1Schema = lazyZodSchema(() => z.union([
  AutomationTriggerDefinitionInputSchema, (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(SessionPullRequestTriggerSchema, { enabled: z.boolean() })),
]));
export type SessionTriggerDefinitionV1 = z.infer<typeof SessionTriggerDefinitionV1Schema>;
export type SessionTriggerDefinitionInputV1 = z.infer<typeof SessionTriggerDefinitionInputV1Schema>;
/** Birth owns the source Session identity; a turn cannot exist before birth. */
export const SessionInitialTriggerDefinitionV1Schema = lazyZodSchema(() => z.union([
  AutomationTriggerDefinitionInputSchema._zod.def.options[0],
  AutomationTriggerDefinitionInputSchema._zod.def.options[1],
  (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(zMini.omit(AutomationTriggerDefinitionInputSchema._zod.def.options[2], { sourceSessionId: true }), {
    policy: z.union([
      AutomationSessionLifecyclePolicySchema._zod.def.options[1],
      AutomationSessionLifecyclePolicySchema._zod.def.options[2],
      AutomationSessionLifecyclePolicySchema._zod.def.options[3],
    ]),
  })),
  AutomationTriggerDefinitionInputSchema._zod.def.options[3],
  (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(SessionPullRequestTriggerSchema, { enabled: z.boolean() })),
]));
export type SessionInitialTriggerDefinitionV1 = z.infer<typeof SessionInitialTriggerDefinitionV1Schema>;
export const SessionInitialTriggerV1Schema = lazyZodSchema(() => z.strictObject({
  target: TriggerTargetV1Schema,
  ...zMini.partial(SessionContextFields).shape,
  trigger: SessionInitialTriggerDefinitionV1Schema,
}).check(z.superRefine((value, ctx) => {
  if (value.target.kind === 'inline' && value.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Inline triggers are private' });
  }
})));
export type SessionInitialTriggerV1 = z.infer<typeof SessionInitialTriggerV1Schema>;
export const SessionTriggerListRequestV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: SessionId }));
export const SessionTriggerAddRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionId, target: TriggerTargetV1Schema,
  /** Ordinary triggers may repeat the authorized Session project; managed scope-end rules use their controller. */
  project: zMini.optional(WorkflowProjectTargetV1Schema),
  ...zMini.partial(SessionContextFields).shape, trigger: SessionTriggerDefinitionInputV1Schema,
}).check(z.superRefine((value, ctx) => {
  if (value.target.kind === 'inline' && value.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Inline triggers are private' });
  }
})));
export const SessionTriggerUpdateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionId, triggerId: AutomationTriggerIdSchema, expectedRevision: Revision,
  patch: z.strictObject({ ...zMini.partial(SessionContextFields).shape, target: zMini.optional(TriggerTargetV1Schema),
    project: zMini.optional(WorkflowProjectTargetV1Schema),
    enabled: z.optional(z.boolean()), trigger: z.optional(SessionTriggerDefinitionV1Schema) }).check(z.refine((patch) => Object.keys(patch).length > 0, 'A trigger update needs a change')),
}));
export const SessionTriggerRemoveRequestV1Schema = lazyZodSchema(() => z.strictObject({ sessionId: SessionId, triggerId: AutomationTriggerIdSchema }));
export const SessionPullRequestLinkV1Schema = lazyZodSchema(() => z.strictObject({
  provider: ScmHostingProviderKindSchema, repository: z.string().check(z.minLength(1)), number: z.number().check(z.int(), z.positive(), z.int()),
  url: z.string().check(z.url()),
  state: z.optional(z.enum(['open', 'merged', 'closed', 'unknown'])),
  observedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type SessionPullRequestLinkV1 = z.infer<typeof SessionPullRequestLinkV1Schema>;
/** Unavailable is not evidence that the Session has no linked pull requests. */
export const SessionTriggerPullRequestLinksV1Schema = lazyZodSchema(() => z.union([
  z.array(SessionPullRequestLinkV1Schema),
  z.strictObject({ status: z.literal('unavailable'), code: z.literal('target_unavailable'),
    diagnostic: z.optional(ActionRefusalDiagnosticV1Schema) }),
]));
export type SessionTriggerPullRequestLinksV1 = z.infer<typeof SessionTriggerPullRequestLinksV1Schema>;
export const SessionTriggerListResultV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowTriggerListResultV1Schema, {
  sessionId: SessionId,
  pullRequestLinks: SessionTriggerPullRequestLinksV1Schema,
})));
export type SessionTriggerListRequestV1 = z.infer<typeof SessionTriggerListRequestV1Schema>;
export type SessionTriggerAddRequestV1 = z.infer<typeof SessionTriggerAddRequestV1Schema>;
export type SessionTriggerUpdateRequestV1 = z.infer<typeof SessionTriggerUpdateRequestV1Schema>;
export type SessionTriggerRemoveRequestV1 = z.infer<typeof SessionTriggerRemoveRequestV1Schema>;
