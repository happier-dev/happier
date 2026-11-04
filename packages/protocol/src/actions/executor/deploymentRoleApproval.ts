import { z } from 'zod/mini';
import { sameStrictJsonValue, StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { formatQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { readExplicitActionApprovalPreferenceV1, resolveActionApprovalRouting } from '../actionApprovalPolicy.js';
import { resolveApprovalSurface } from '../actionApprovalSurface.js';
import { ActionIdSchema } from '../actionIds.js';
import type { ActionId } from '../actionIds.js';
import { getActionSpec } from '../actionSpecs.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { readActionApprovalScopeAdmissionV1 } from './approvalScope.js';
import type { ActionHomeEquivalence, PreparedCoreAdmission } from './coreInvocation.js';
import type { ActionApprovalScopeV1, ActionSettingsActionId } from '../actionSettings.js';
import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure, HostReviewedChildrenPlanV1, HostReviewedChildrenPreparationV1 } from './types.js';
import { isHostAdmittedReviewedChildPolicyV1, readHostReviewedChildOperationV1, type HostReviewedChildPolicyV1 } from './deploymentRoleChild.js';

const hostReviewedChildrenSchema = z.strictObject({
  children: z.array(z.strictObject({ action: z.union([ActionIdSchema, asProtocolZod(PluginContributionIdentityV1Schema)]),
    role: z.string().check(z.minLength(1)), input: z.optional(StrictJsonValueSchema),
    scopeInput: z.optional(z.record(z.string(), StrictJsonValueSchema)) })),
});

/** Stored review facts are closed; they never create a host invocation port. */
export function readHostReviewedChildrenPlanV1(value: unknown): HostReviewedChildrenPlanV1 | undefined {
  const parsed = hostReviewedChildrenSchema.safeParse(value);
  return parsed.success && parsed.data.children.length > 0 ? parsed.data : undefined;
}

/** Resolve demanded child policy once at the parent's natural preparation boundary. */
export function prepareHostReviewedChildPolicyV1(child: HostReviewedChildrenPlanV1['children'][number],
  context: ActionExecutorContext, approvalScope?: ActionApprovalScopeV1, reviewAdmitted = false): (HostReviewedChildPolicyV1 & Readonly<{ requiredActionIds: readonly string[] }>) | null {
  const settings = context.actionsSettings;
  const surface = resolveApprovalSurface(context);
  if (!settings || surface.kind === 'ambiguous') return null;
  const candidateIds: readonly ActionSettingsActionId[] = typeof child.action === 'string'
    ? [child.action] : ['action.invoke', formatQualifiedPluginActionId(child.action)];
  return { action: child.action, role: child.role, surface: surface.surface,
    requiredActionIds: candidateIds.filter(id => typeof child.action === 'string'
      ? resolveActionApprovalRouting({ actionId: child.action, spec: getActionSpec(child.action),
        input: child.input === undefined ? child.scopeInput : child.input,
        context: { ...context, bypassApprovals: false }, settings, reviewAdmitted, ...(approvalScope ? { approvalScope } : {}) }).required
      : readExplicitActionApprovalPreferenceV1(id, settings, context, approvalScope) === true) };
}

/** Prepare demanded effects once; prepared dispatch retains this exact admission. */
export async function prepareHostReviewedChildrenV1(params: Readonly<{
  actionId: ActionId; input: unknown; context: ActionExecutorContext; deps: ActionExecutorDeps;
  declaredChildren?: HostReviewedChildrenPlanV1['children'];
  /** The root's exact native confirmation answers demanded defaults, never explicit Require. */
  reviewAdmitted?: boolean;
  approvalScope?: ActionApprovalScopeV1;
  existing?: PreparedCoreAdmission; approvalReplay: boolean; isSameHome: ActionHomeEquivalence;
}>): Promise<Readonly<{ plan?: HostReviewedChildrenPlanV1; policies?: readonly HostReviewedChildPolicyV1[];
  executeAdmittedAction?: HostReviewedChildrenPreparationV1['executeAdmittedAction'];
  prepareExecutionContext?: HostReviewedChildrenPreparationV1['prepareExecutionContext'];
  approvalPreview?: HostReviewedChildrenPreparationV1['approvalPreview'];
  admittedReviewedChild?: true;
  reviewRequired: boolean }> | ActionExecuteFailure> {
  const { actionId, context, deps, existing } = params;
  if (existing) return { plan: existing.hostReviewedChildren, policies: existing.hostReviewedChildPolicies,
    ...(existing.prepareExecutionContext ? { prepareExecutionContext: existing.prepareExecutionContext } : {}),
    ...(existing.executeAdmittedAction ? { executeAdmittedAction: existing.executeAdmittedAction } : {}), reviewRequired: false };
  const reviewedChild = readHostReviewedChildOperationV1(context, actionId, params.input);
  // The exact admitted child consumes its original closed plan, not another preparation or review.
  if (isHostAdmittedReviewedChildPolicyV1(reviewedChild, actionId, params.input))
    return { admittedReviewedChild: true, reviewRequired: false };
  // A private-schema host original is still original work.
  const machineRuntimeDemand = reviewedChild ? null
    : getActionSpec(actionId).machineRuntimeDemandForInput?.(params.input, context);
  const prepared = actionId === 'template.instantiate' && deps.prepareBotTemplateInstantiation
    ? await deps.prepareBotTemplateInstantiation({ input: params.input,
      context: { ...context, runActionOperation: context.runActionOperation ?? deps.runActionOperation } })
    : actionId === 'template.release' && deps.prepareBotTemplateRelease
      ? await deps.prepareBotTemplateRelease({ input: params.input, context })
    : actionId === 'template.updates.apply' && deps.prepareBotTemplateUpdate
      ? await deps.prepareBotTemplateUpdate({ input: params.input,
        context: { ...context, runActionOperation: context.runActionOperation ?? deps.runActionOperation } })
    : await deps.prepareHostReviewedChildren?.({ actionId, input: params.input, context,
      ...(machineRuntimeDemand ? { machineRuntimeDemand } : {}) });
  if (prepared && 'ok' in prepared) return prepared;
  const declarations = prepared || params.declaredChildren ? {
    children: [...(prepared?.children ?? []), ...(params.declaredChildren ?? [])],
  } : undefined;
  const plan = declarations ? readHostReviewedChildrenPlanV1(declarations) : undefined;
  if (declarations && declarations.children.length > 0 && !plan) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  const policies: HostReviewedChildPolicyV1[] = [];
  for (const child of plan?.children ?? []) {
    const childId = typeof child.action === 'string' ? child.action : 'action.invoke';
    const operand = child.input === undefined ? child.scopeInput : child.input;
    const input = typeof child.action === 'string' ? operand : { action: child.action, input: operand };
    const scope = operand === undefined ? { approvalScope: params.approvalScope }
      : await readActionApprovalScopeAdmissionV1({ actionId: childId, spec: getActionSpec(childId), input,
      context, deps, phase: params.approvalReplay ? 'replay' : 'prepare', isSameHome: params.isSameHome });
    if ('ok' in scope) return scope;
    const policy = prepareHostReviewedChildPolicyV1(child, context, scope.approvalScope, params.reviewAdmitted);
    if (!policy) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    policies.push(policy);
  }
  const witness = context.presentUserApproval;
  const retained = witness?.actionId === actionId ? context.approvedActionReplay?.hostReviewedChildren : undefined;
  const witnessed = Boolean(plan && retained && context.approvedActionReplay && witness
    && witness.artifactId === context.approvedActionReplay.artifactId && witness.actionId === actionId
    && witness.requestId === context.actionRequestId && witness.decidingAccountId
    && witness.inputDigest === computeActionInputApprovalDigestV1(actionId, params.input)
    && sameStrictJsonValue(plan, retained));
  if (retained && !witnessed || params.approvalReplay && plan && !witnessed)
    return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
  return { ...(plan ? { plan, policies } : {}),
    ...(prepared?.prepareExecutionContext ? { prepareExecutionContext: prepared.prepareExecutionContext } : {}),
    ...(prepared?.approvalPreview ? { approvalPreview: prepared.approvalPreview } : {}),
    ...(prepared?.executeAdmittedAction ? { executeAdmittedAction: prepared.executeAdmittedAction } : {}),
    reviewRequired: !witnessed && policies.some(policy => (policy.requiredActionIds?.length ?? 0) > 0) };
}
