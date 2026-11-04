import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ScmHostingProviderKindSchema } from '../../scm/pullRequests.js';
import { z } from 'zod/mini';
import { WorkflowDestinationsV1Schema } from '../workflowDestinationsV1.js';
import { AutomationTriggerDefinitionInputSchema, AutomationTriggerDefinitionSchema } from '../../automations/automationTriggerDefinition.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import { AutomationIdV1Schema } from '../../automations/automationIdV1.js';
import { AutomationManualIdempotencyKeyV1Schema } from '../../automations/automationOccurrenceV1.js';
import { AutomationTriggerDetailSchema, AutomationScheduleTriggerProjectionSchema,
  AutomationPluginEventTriggerProjectionSchema, AutomationSessionLifecycleTriggerProjectionSchema } from '../../automations/automationTriggerProjectionV1.js';
import { AutomationRunLifecycleTriggerSchema } from '../../automations/automationRunLifecycle.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationManagedTargetV1Schema, AutomationObservationOnlyDefinitionV1Schema, AutomationStoredWorkflowDefinitionV2Schema } from '../../automations/automationWorkflowRecipeV2.js';
import { WorkflowProjectTargetV1Schema } from '../workflowWorkspaceV1.js';
import { WorkflowDefinitionRefV1StringSchema } from '../workflowDefinitionRefV1.js';
import { TriggerTargetV1Schema } from './triggerTargetV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { AutomationPullRequestTriggerSchema } from '../../automations/automationTriggerDefinition.js';
import { AutomationSessionLifecyclePolicySchema } from '../../automations/automationSessionLifecycle.js';

const Revision = z.number().check(z.int(), z.nonnegative(), z.int());
/** Only public list-safe inputs consumed by the shared human-readable trigger summary. */
export const WorkflowTriggerSummaryInputV1Schema = lazyZodSchema(() => {
  const historyIdentity = {
    automationId: zMini.optional(asProtocolZod(AutomationIdV1Schema)),
    triggerId: zMini.optional(AutomationTriggerIdSchema),
  };
  return z.discriminatedUnion('kind', [
    zMini.extend(zMini.pick(AutomationScheduleTriggerProjectionSchema, { kind: true, schedule: true }), historyIdentity),
    zMini.extend(zMini.pick(AutomationPluginEventTriggerProjectionSchema, { kind: true, eventRef: true }), historyIdentity),
    zMini.extend(zMini.pick(AutomationSessionLifecycleTriggerProjectionSchema, { kind: true, events: true }), historyIdentity),
    zMini.extend(zMini.pick(AutomationRunLifecycleTriggerSchema, { kind: true, condition: true }), historyIdentity),
    z.strictObject({ kind: z.literal('prComment'), ...historyIdentity }),
    z.strictObject({ kind: z.literal('ciFailed'), ...historyIdentity }),
  ]);
});
export type WorkflowTriggerSummaryInputV1 = z.infer<typeof WorkflowTriggerSummaryInputV1Schema>;
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
      const historyIdentity = { automationId: row.id, triggerId: trigger.id };
      switch (trigger.kind) {
        case 'schedule': summary.triggers.push({ ...historyIdentity, kind: trigger.kind, schedule: trigger.schedule }); break;
        case 'pluginEvent': summary.triggers.push({ ...historyIdentity, kind: trigger.kind, eventRef: trigger.eventRef }); break;
        case 'sessionLifecycle': summary.triggers.push({ ...historyIdentity, kind: trigger.kind, events: trigger.events }); break;
        case 'runLifecycle': summary.triggers.push({ ...historyIdentity, kind: trigger.kind, condition: trigger.condition }); break;
        case 'prComment': case 'ciFailed': summary.triggers.push({ ...historyIdentity, kind: trigger.kind }); break;
      }
      if (trigger.kind === 'schedule' && row.enabled && trigger.enabled && trigger.nextRunAt !== null) {
        summary.nextRunAt = summary.nextRunAt === null ? trigger.nextRunAt : Math.min(summary.nextRunAt, trigger.nextRunAt);
      }
    }
    result.set(row.workflowDefinitionId, summary);
  }
  return result;
}
const ContextFields = lazyZodSchema(() => zMini.omit(AutomationStoredWorkflowDefinitionV2Schema, { workspace: true, inlineDefinition: true, onComplete: true }));
export const WorkflowTriggerListRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ workflow: WorkflowDefinitionRefV1StringSchema }),
  z.strictObject({ managedTarget: AutomationManagedTargetV1Schema }),
  z.strictObject({ scope: z.enum(['account_inline', 'account_all']) }),
  z.strictObject({ automationId: asProtocolZod(AutomationIdV1Schema), review: z.literal(true) }),
]));
const WorkflowTriggerExecutableAddRequestV1Schema = lazyZodSchema(() => z.strictObject({
  workflow: zMini.optional(WorkflowDefinitionRefV1StringSchema),
  target: zMini.optional(TriggerTargetV1Schema),
  project: WorkflowProjectTargetV1Schema,
  observationOnly: z.optional(z.never()),
  ...zMini.partial(ContextFields).shape,
  trigger: AutomationTriggerDefinitionInputSchema,
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
  }).check(z.refine((patch) => Object.keys(patch).length > 0, 'A trigger update needs a change')),
}).check(z.superRefine((value, ctx) => {
  if (value.patch.trigger !== undefined && value.triggerId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['triggerId'], message: 'A trigger definition update needs its trigger id' });
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
export const WorkflowTriggerSetV1Schema = lazyZodSchema(() => z.strictObject({
  /** Display facts from the already-admitted Account record, not another lookup. */
  name: z.optional(z.string()),
  updatedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
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
    AutomationTriggerDetailSchema._zod.def.options[2], AutomationTriggerDetailSchema._zod.def.options[3],
    AutomationTriggerDetailSchema._zod.def.options[4], AutomationTriggerDetailSchema._zod.def.options[5],
    OpenedPullRequestTriggerDetailSchema,
  ])),
}));
export const WorkflowTriggerListResultV1Schema = lazyZodSchema(() => z.strictObject({ sets: z.array(WorkflowTriggerSetV1Schema) }));
export const WorkflowTriggerWriteResultV1Schema = lazyZodSchema(() => z.strictObject({
  set: WorkflowTriggerSetV1Schema,
  triggerId: zMini.optional(AutomationTriggerIdSchema),
  triggerRevision: z.optional(Revision),
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

const SessionId = asProtocolZod(SessionIdSchema);
const SessionContextFields = lazyZodSchema(() => zMini.omit(AutomationStoredWorkflowDefinitionV2Schema, { workspace: true, inlineDefinition: true }));
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
  z.strictObject({ status: z.literal('unavailable'), code: z.literal('target_unavailable') }),
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
