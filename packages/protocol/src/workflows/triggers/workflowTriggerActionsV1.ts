import { z } from 'zod';
import { AutomationTriggerDefinitionInputSchema, AutomationTriggerDefinitionSchema } from '../../automations/automationTriggerDefinition.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import { AutomationIdV1Schema } from '../../automations/automationIdV1.js';
import { AutomationTriggerDetailSchema, AutomationScheduleTriggerProjectionSchema,
  AutomationPluginEventTriggerProjectionSchema, AutomationSessionLifecycleTriggerProjectionSchema } from '../../automations/automationTriggerProjectionV1.js';
import { AutomationRunLifecycleTriggerSchema } from '../../automations/automationRunLifecycle.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationStoredWorkflowDefinitionV2Schema } from '../../automations/automationWorkflowRecipeV2.js';
import { WorkflowProjectTargetV1Schema } from '../workflowWorkspaceV1.js';
import { WorkflowDefinitionRefV1StringSchema } from '../workflowDefinitionRefV1.js';
import { TriggerTargetV1Schema } from './triggerTargetV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { AutomationPullRequestTriggerSchema } from '../../automations/automationTriggerDefinition.js';
import { AutomationSessionLifecyclePolicySchema } from '../../automations/automationSessionLifecycle.js';

const Revision = z.number().int().nonnegative().safe();
/** Only public list-safe inputs consumed by the shared human-readable trigger summary. */
export const WorkflowTriggerSummaryInputV1Schema = z.discriminatedUnion('kind', [
  AutomationScheduleTriggerProjectionSchema.pick({ kind: true, schedule: true }),
  AutomationPluginEventTriggerProjectionSchema.pick({ kind: true, eventRef: true }),
  AutomationSessionLifecycleTriggerProjectionSchema.pick({ kind: true, events: true }),
  AutomationRunLifecycleTriggerSchema.pick({ kind: true, condition: true }),
  z.object({ kind: z.literal('prComment') }).strict(),
  z.object({ kind: z.literal('ciFailed') }).strict(),
]);
export type WorkflowTriggerSummaryInputV1 = z.infer<typeof WorkflowTriggerSummaryInputV1Schema>;
const ContextFields = AutomationStoredWorkflowDefinitionV2Schema.omit({ workspace: true, inlineDefinition: true, onComplete: true });
export const WorkflowTriggerListRequestV1Schema = z.union([
  z.object({ workflow: WorkflowDefinitionRefV1StringSchema }).strict(),
  z.object({ scope: z.literal('account_inline') }).strict(),
]);
export const WorkflowTriggerAddRequestV1Schema = z.object({
  workflow: WorkflowDefinitionRefV1StringSchema.optional(),
  target: TriggerTargetV1Schema.optional(),
  project: WorkflowProjectTargetV1Schema,
  ...ContextFields.partial().shape,
  trigger: AutomationTriggerDefinitionInputSchema,
}).strict().superRefine((value, ctx) => {
  if ((value.workflow === undefined) === (value.target === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'Choose exactly one workflow or target' });
  }
  if (value.target?.kind === 'inline' && value.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Inline triggers are private' });
  }
});
export const WorkflowTriggerUpdateRequestV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema.optional(),
  expectedRevision: Revision,
  patch: z.object({
    project: WorkflowProjectTargetV1Schema.optional(),
    ...ContextFields.partial().shape,
    target: TriggerTargetV1Schema.optional(),
    enabled: z.boolean().optional(),
    trigger: AutomationTriggerDefinitionSchema.optional(),
  }).strict().refine((patch) => Object.keys(patch).length > 0, 'A trigger update needs a change'),
}).strict().superRefine((value, ctx) => {
  if (value.patch.trigger !== undefined && value.triggerId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['triggerId'], message: 'A trigger definition update needs its trigger id' });
  }
  if (value.patch.target?.kind === 'inline' && value.patch.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['patch', 'visibleTeamId'], message: 'Inline triggers are private' });
  }
});
export const WorkflowTriggerRemoveRequestV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema), triggerId: AutomationTriggerIdSchema,
}).strict();
const OpenedPullRequestTriggerDetailSchema = z.object({
  id: AutomationTriggerIdSchema, revision: Revision, enabled: z.boolean(),
  createdAt: z.number().int().nonnegative().safe(), updatedAt: z.number().int().nonnegative().safe(),
  sourceSessionId: asProtocolZod(SessionIdSchema), triggerDefinitionEnvelope: z.string().min(1),
  ...AutomationPullRequestTriggerSchema.shape,
}).strict();
export const WorkflowTriggerSetV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema), revision: Revision, enabled: z.boolean(),
  health: z.enum(['available', 'source_unavailable']),
  legacy: z.object({ editable: z.literal(false), reason: z.literal('created_in_0_2'),
    lockedReason: z.enum(['session_key_required', 'migration_required', 'decryption_failed']).optional(),
    placements: z.array(WorkflowProjectTargetV1Schema.pick({ machineId: true, directory: true })).optional(),
  }).strict().optional(),
  target: TriggerTargetV1Schema.optional(),
  project: WorkflowProjectTargetV1Schema.optional(),
  context: AutomationStoredWorkflowDefinitionV2Schema.optional(),
  triggers: z.array(z.union([
    AutomationTriggerDetailSchema.options[2], AutomationTriggerDetailSchema.options[3],
    AutomationTriggerDetailSchema.options[4], AutomationTriggerDetailSchema.options[5],
    OpenedPullRequestTriggerDetailSchema,
  ])),
}).strict();
export const WorkflowTriggerListResultV1Schema = z.object({ sets: z.array(WorkflowTriggerSetV1Schema) }).strict();
export const WorkflowTriggerWriteResultV1Schema = z.object({
  set: WorkflowTriggerSetV1Schema,
  triggerId: AutomationTriggerIdSchema.optional(),
  triggerRevision: Revision.optional(),
}).strict();
export type WorkflowTriggerListRequestV1 = z.infer<typeof WorkflowTriggerListRequestV1Schema>;
export type WorkflowTriggerAddRequestV1 = z.infer<typeof WorkflowTriggerAddRequestV1Schema>;
export type WorkflowTriggerUpdateRequestV1 = z.infer<typeof WorkflowTriggerUpdateRequestV1Schema>;
export type WorkflowTriggerRemoveRequestV1 = z.infer<typeof WorkflowTriggerRemoveRequestV1Schema>;
export type WorkflowTriggerSetV1 = z.infer<typeof WorkflowTriggerSetV1Schema>;

const SessionId = asProtocolZod(SessionIdSchema);
const SessionContextFields = AutomationStoredWorkflowDefinitionV2Schema.omit({ workspace: true, inlineDefinition: true });
const SessionPullRequestTriggerSchema = AutomationPullRequestTriggerSchema.extend({
  pullRequest: AutomationPullRequestTriggerSchema.shape.pullRequest.optional(),
}).strict();
export const SessionTriggerDefinitionV1Schema = z.union([AutomationTriggerDefinitionSchema, SessionPullRequestTriggerSchema]);
export const SessionTriggerDefinitionInputV1Schema = z.union([
  AutomationTriggerDefinitionInputSchema, SessionPullRequestTriggerSchema.extend({ enabled: z.boolean() }).strict(),
]);
export type SessionTriggerDefinitionV1 = z.infer<typeof SessionTriggerDefinitionV1Schema>;
export type SessionTriggerDefinitionInputV1 = z.infer<typeof SessionTriggerDefinitionInputV1Schema>;
/** Birth owns the source Session identity; a turn cannot exist before birth. */
export const SessionInitialTriggerDefinitionV1Schema = z.union([
  AutomationTriggerDefinitionInputSchema.options[0],
  AutomationTriggerDefinitionInputSchema.options[1],
  AutomationTriggerDefinitionInputSchema.options[2].omit({ sourceSessionId: true }).extend({
    policy: z.union([
      AutomationSessionLifecyclePolicySchema.options[1],
      AutomationSessionLifecyclePolicySchema.options[2],
      AutomationSessionLifecyclePolicySchema.options[3],
    ]),
  }).strict(),
  AutomationTriggerDefinitionInputSchema.options[3],
  SessionPullRequestTriggerSchema.extend({ enabled: z.boolean() }).strict(),
]);
export type SessionInitialTriggerDefinitionV1 = z.infer<typeof SessionInitialTriggerDefinitionV1Schema>;
export const SessionInitialTriggerV1Schema = z.object({
  target: TriggerTargetV1Schema,
  ...SessionContextFields.partial().shape,
  trigger: SessionInitialTriggerDefinitionV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.target.kind === 'inline' && value.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Inline triggers are private' });
  }
});
export type SessionInitialTriggerV1 = z.infer<typeof SessionInitialTriggerV1Schema>;
export const SessionTriggerListRequestV1Schema = z.object({ sessionId: SessionId }).strict();
export const SessionTriggerAddRequestV1Schema = z.object({
  sessionId: SessionId, target: TriggerTargetV1Schema,
  ...SessionContextFields.partial().shape, trigger: SessionTriggerDefinitionInputV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.target.kind === 'inline' && value.visibleTeamId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['visibleTeamId'], message: 'Inline triggers are private' });
  }
});
export const SessionTriggerUpdateRequestV1Schema = z.object({
  sessionId: SessionId, triggerId: AutomationTriggerIdSchema, expectedRevision: Revision,
  patch: z.object({ ...SessionContextFields.partial().shape, target: TriggerTargetV1Schema.optional(),
    enabled: z.boolean().optional(), trigger: SessionTriggerDefinitionV1Schema.optional() }).strict()
    .refine((patch) => Object.keys(patch).length > 0, 'A trigger update needs a change'),
}).strict();
export const SessionTriggerRemoveRequestV1Schema = z.object({ sessionId: SessionId, triggerId: AutomationTriggerIdSchema }).strict();
export const SessionPullRequestLinkV1Schema = z.object({
  provider: z.literal('github'), repository: z.string().min(1), number: z.number().int().positive().safe(),
}).strict();
export type SessionPullRequestLinkV1 = z.infer<typeof SessionPullRequestLinkV1Schema>;
/** Unavailable is not evidence that the Session has no linked pull requests. */
export const SessionTriggerPullRequestLinksV1Schema = z.union([
  z.array(SessionPullRequestLinkV1Schema),
  z.object({ status: z.literal('unavailable'), code: z.literal('target_unavailable') }).strict(),
]);
export type SessionTriggerPullRequestLinksV1 = z.infer<typeof SessionTriggerPullRequestLinksV1Schema>;
export const SessionTriggerListResultV1Schema = WorkflowTriggerListResultV1Schema.extend({
  sessionId: SessionId,
  pullRequestLinks: SessionTriggerPullRequestLinksV1Schema,
}).strict();
export type SessionTriggerListRequestV1 = z.infer<typeof SessionTriggerListRequestV1Schema>;
export type SessionTriggerAddRequestV1 = z.infer<typeof SessionTriggerAddRequestV1Schema>;
export type SessionTriggerUpdateRequestV1 = z.infer<typeof SessionTriggerUpdateRequestV1Schema>;
export type SessionTriggerRemoveRequestV1 = z.infer<typeof SessionTriggerRemoveRequestV1Schema>;
