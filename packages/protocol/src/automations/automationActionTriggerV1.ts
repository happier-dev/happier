import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationTriggerActionIdV1Schema, AutomationActionPhaseV1Schema } from './automationActionIdentityV1.js';
export { AutomationTriggerActionIdV1Schema } from './automationActionIdentityV1.js';
import {
  AutomationSubjectV1Schema,
  AutomationSubjectStructuralV1Schema,
  checkAutomationSubjectStructuralV1,
  projectAutomationSubjectStructuralV1,
} from './automationSubjectV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationStoredContentEnvelopeV1Schema } from './automationStoredContentEnvelopeV1.js';
import { AutomationEventFilterV1Schema } from './automationEventFilterV1.js';

export const AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 = '/v1/automations/actions/index';

function checkActionPhase(trigger: Readonly<{ phase: string; mode?: string; onFailure?: string }>,
  context: { addIssue: (issue: { code: 'custom'; path: string[]; message: string }) => void }) {
  if (trigger.phase === 'after' && (trigger.mode !== undefined || trigger.onFailure !== undefined)) {
    context.addIssue({ code: 'custom', path: ['phase'], message: 'After Actions do not wait for a check' });
  }
  if (trigger.mode === 'notify' && trigger.onFailure !== undefined) {
    context.addIssue({ code: 'custom', path: ['onFailure'], message: 'Only wait checks have a failure decision' });
  }
}

export const AutomationActionTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('action'),
  phase: AutomationActionPhaseV1Schema,
  actionIds: z.array(AutomationTriggerActionIdV1Schema).check(z.minLength(1)),
  subject: z.optional(AutomationSubjectV1Schema),
  /** Authored Only-when content remains in the private definition, outside public routing tuples. */
  filter: z.optional(z.nullable(AutomationEventFilterV1Schema)),
  mode: z.optional(z.enum(['wait', 'notify'])),
  onFailure: z.optional(z.enum(['refuse', 'ask'])),
}).check(z.superRefine(checkActionPhase)));
export type AutomationActionTrigger = z.infer<typeof AutomationActionTriggerSchema>;

function checkActionStructural(trigger: Readonly<{ phase: string; mode?: string; onFailure?: string;
  subjectKind?: string; subjectKey?: string }>, context: Parameters<typeof checkActionPhase>[1]) {
  checkActionPhase(trigger, context);
  checkAutomationSubjectStructuralV1(trigger, context);
}

/** Home indexes public routing facts; authored subjects stay in the private definition. */
export const AutomationActionTriggerStructuralV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('action'),
  phase: AutomationActionTriggerSchema.shape.phase,
  actionIds: AutomationActionTriggerSchema.shape.actionIds,
  mode: AutomationActionTriggerSchema.shape.mode,
  onFailure: AutomationActionTriggerSchema.shape.onFailure,
  ...AutomationSubjectStructuralV1Schema.shape,
  reachesOthers: z.optional(z.boolean()),
}).check(z.superRefine(checkActionStructural)));
export const AutomationActionEncryptedTriggerSchema = lazyZodSchema(() => z.strictObject({
  ...AutomationActionTriggerStructuralV1Schema.shape,
  triggerDefinitionEnvelope: AutomationStoredContentEnvelopeV1Schema,
}).check(z.superRefine(checkActionStructural)));
export type AutomationActionEncryptedTrigger = z.infer<typeof AutomationActionEncryptedTriggerSchema>;

/** The one authored-definition to public matching projection. */
export function projectAutomationActionTriggerStructuralV1(trigger: AutomationActionTrigger) {
  return AutomationActionTriggerStructuralV1Schema.parse({
    kind: trigger.kind, phase: trigger.phase, actionIds: trigger.actionIds,
    ...(trigger.mode === undefined ? {} : { mode: trigger.mode }),
    ...(trigger.onFailure === undefined ? {} : { onFailure: trigger.onFailure }),
    ...projectAutomationSubjectStructuralV1(trigger.subject),
  });
}

/** An actor's consent refers to the shared link; it is never a second matching trigger. */
export const AutomationActionConsentTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('action'),
  consentFor: z.strictObject({ automationId: z.string().check(z.minLength(1)), triggerId: AutomationTriggerIdSchema }),
  consentedWorkflowRevision: AutomationTriggerRevisionSchema,
}));
export type AutomationActionConsentTrigger = z.infer<typeof AutomationActionConsentTriggerSchema>;

export const AutomationActionTriggerInputSchema = lazyZodSchema(() => z.union([
  z.extend(AutomationActionEncryptedTriggerSchema, { enabled: z.boolean() }),
  z.extend(AutomationActionTriggerSchema, { enabled: z.boolean() }),
  z.extend(AutomationActionConsentTriggerSchema, { enabled: z.boolean() }),
]));

/** Structural projection only. Private trigger context and Workflow content never enter this index. */
export const ActionAutomationTriggerReferenceV1Schema = lazyZodSchema(() => {
  const { kind: _kind, ...matching } = AutomationActionTriggerStructuralV1Schema.shape;
  return z.strictObject({ ...matching,
    automationId: z.string(), triggerId: AutomationTriggerIdSchema, triggerRevision: AutomationTriggerRevisionSchema,
    workflowId: z.string(), workflowRevision: AutomationTriggerRevisionSchema, ownerAccountId: z.string(),
    consentFor: z.optional(AutomationActionConsentTriggerSchema.shape.consentFor),
    consentedWorkflowRevision: z.optional(AutomationActionConsentTriggerSchema.shape.consentedWorkflowRevision),
  });
});

/** Consent rows refer to the shared trigger; their reviewed facts remain private. */
export const ActionAutomationConsentReferenceV1Schema = lazyZodSchema(() => {
  const reference = ActionAutomationTriggerReferenceV1Schema.shape;
  return z.strictObject({
    automationId: reference.automationId, triggerId: reference.triggerId, triggerRevision: reference.triggerRevision,
    workflowId: reference.workflowId, workflowRevision: reference.workflowRevision, ownerAccountId: reference.ownerAccountId,
    consentFor: AutomationActionConsentTriggerSchema.shape.consentFor,
    consentedWorkflowRevision: AutomationActionConsentTriggerSchema.shape.consentedWorkflowRevision,
  });
});
export const ActionAutomationIndexRowV1Schema = lazyZodSchema(() => z.union([
  ActionAutomationTriggerReferenceV1Schema, ActionAutomationConsentReferenceV1Schema,
]));
export const ActionAutomationIndexV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), rows: z.array(ActionAutomationIndexRowV1Schema),
}));
/** Existing Account change cursors select the scopes to replace after reconnect. */
export const ActionAutomationIndexSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  automationIds: z.array(z.string()), workflowDefinitionIds: z.array(z.string()),
}));
export type ActionAutomationIndexSelectionV1 = z.infer<typeof ActionAutomationIndexSelectionV1Schema>;
/** One complete replacement, so removing or disabling a trigger needs no refetch. */
export const ActionAutomationIndexChangeV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: z.string(), rows: z.array(ActionAutomationIndexRowV1Schema),
}));
export type ActionAutomationIndexChangeV1 = z.infer<typeof ActionAutomationIndexChangeV1Schema>;
