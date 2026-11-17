import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationSubjectV1Schema, AutomationSubjectContextV1Schema } from '../automations/automationSubjectV1.js';
import { ActionAutomationTriggerReferenceV1Schema, AutomationActionConsentTriggerSchema } from '../automations/automationActionTriggerV1.js';
import { ApprovalDecisionV2Schema } from './approvalRequestV1.js';
import { ActionAutomationNoticeV1Schema } from '../actions/actionExecutionResult.js';

const id = () => z.string().check(z.minLength(1));
const triggerRef = () => AutomationActionConsentTriggerSchema.shape.consentFor.shape;

/** Exact reviewed admission facts. A trigger id is scoped to its Automation row. */
export const ApprovalAutomaticSelectedTriggerV1Schema = lazyZodSchema(() => z.strictObject({
  ...ActionAutomationTriggerReferenceV1Schema.shape, subject: z.optional(AutomationSubjectV1Schema),
}));
export type ApprovalAutomaticSelectedTriggerV1 = z.infer<typeof ApprovalAutomaticSelectedTriggerV1Schema>;

export const ActionAutomationConsentV1Schema = lazyZodSchema(() => z.strictObject({
  ...triggerRef(), decision: z.enum(['pending', 'allow', 'skip']),
  actorConsent: z.optional(ActionAutomationTriggerReferenceV1Schema),
}));
export type ActionAutomationConsentV1 = z.infer<typeof ActionAutomationConsentV1Schema>;

export const ActionAutomationRunV1Schema = lazyZodSchema(() => z.strictObject({ ...triggerRef(), runId: id() }));
export type ActionAutomationRunV1 = z.infer<typeof ActionAutomationRunV1Schema>;

export const ActionAutomationResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ActionAutomationRunV1Schema.shape, outcome: z.enum(['passed', 'failed', 'canceled', 'unavailable']),
  resultId: z.optional(id()), reason: z.optional(id()),
}));
export type ActionAutomationResultV1 = z.infer<typeof ActionAutomationResultV1Schema>;

export function actionAutomationTriggerKeyV1(ref: Readonly<{ automationId: string; triggerId: string }>): string {
  return JSON.stringify([ref.automationId, ref.triggerId]);
}

/** Pending progress lives on the existing Approval; Run progress remains on its Run. */
export const ApprovalAutomaticChecksV1Schema = lazyZodSchema(() => z.strictObject({
  phase: z.enum(['consent', 'checking', 'override', 'passed', 'refused']),
  humanApprovalRequired: z.boolean(), humanDecision: z.optional(ApprovalDecisionV2Schema),
  subjects: z.array(AutomationSubjectContextV1Schema),
  selectionStatus: z.enum(['ready', 'unavailable']), notices: z.array(ActionAutomationNoticeV1Schema),
  selected: z.array(ApprovalAutomaticSelectedTriggerV1Schema),
  consents: z.array(ActionAutomationConsentV1Schema), runs: z.array(ActionAutomationRunV1Schema),
  results: z.array(ActionAutomationResultV1Schema),
}).check(z.superRefine((value, ctx) => {
  const selected = new Map(value.selected.map(row => [actionAutomationTriggerKeyV1(row), row]));
  if (selected.size !== value.selected.length) ctx.addIssue({ code: 'custom', path: ['selected'], message: 'Selected trigger references must be distinct' });
  for (const field of ['consents', 'runs'] as const) {
    const keys = value[field].map(actionAutomationTriggerKeyV1);
    if (new Set(keys).size !== keys.length || keys.some(key => !selected.has(key))) {
      ctx.addIssue({ code: 'custom', path: [field], message: 'References must belong to distinct selected triggers' });
    }
  }
  if (value.consents.some(consent => consent.actorConsent && (consent.decision === 'skip'
    || consent.actorConsent.consentFor?.automationId !== consent.automationId
    || consent.actorConsent.consentFor?.triggerId !== consent.triggerId))) {
    ctx.addIssue({ code: 'custom', path: ['consents'], message: 'Saved actor consent must belong to the allowed shared trigger' });
  }
  const runs = new Map(value.runs.map(run => [actionAutomationTriggerKeyV1(run), run.runId]));
  const results = value.results.map(actionAutomationTriggerKeyV1);
  if (new Set(results).size !== results.length || value.results.some(result => runs.get(actionAutomationTriggerKeyV1(result)) !== result.runId)) {
    ctx.addIssue({ code: 'custom', path: ['results'], message: 'Results must belong to the recorded Runs' });
  }
  if (value.humanDecision && value.humanDecision.kind !== 'approve') {
    ctx.addIssue({ code: 'custom', path: ['humanDecision'], message: 'The retained human fact must be approval' });
  }
  if ((value.phase === 'checking' || value.phase === 'passed') && value.humanApprovalRequired && !value.humanDecision) {
    ctx.addIssue({ code: 'custom', path: ['humanDecision'], message: 'Checks cannot precede the required human decision' });
  }
  if ((value.phase === 'checking' || value.phase === 'passed') && value.consents.some(consent => consent.decision === 'pending')) {
    ctx.addIssue({ code: 'custom', path: ['consents'], message: 'Unanswered consent cannot advance the Action' });
  }
  if (value.phase === 'passed' && value.selected.some(selection => selection.phase === 'before' && selection.mode !== 'notify'
    && !value.consents.some(consent => actionAutomationTriggerKeyV1(consent) === actionAutomationTriggerKeyV1(selection) && consent.decision === 'skip')
    && !value.notices.some(notice => notice.code === 'action_automation_skipped' && actionAutomationTriggerKeyV1(notice) === actionAutomationTriggerKeyV1(selection))
    && !value.results.some(result => actionAutomationTriggerKeyV1(result) === actionAutomationTriggerKeyV1(selection)))) {
    ctx.addIssue({ code: 'custom', path: ['results'], message: 'A completed wait requires its recorded result' });
  }
})));
export type ApprovalAutomaticChecksV1 = z.infer<typeof ApprovalAutomaticChecksV1Schema>;

/** A check-only pass is execution admission, never a forged person decision. */
export function isApprovalRequestExecutionApproved(request: Readonly<{
  decision?: Readonly<{ kind: string }>;
  automaticChecks?: Readonly<{ phase: string; humanApprovalRequired: boolean; humanDecision?: Readonly<{ kind: string }> }>;
}>): boolean {
  if (!request.automaticChecks) return request.decision?.kind === 'approve';
  return request.automaticChecks.phase === 'passed'
    && (!request.automaticChecks.humanApprovalRequired || request.automaticChecks.humanDecision?.kind === 'approve');
}
