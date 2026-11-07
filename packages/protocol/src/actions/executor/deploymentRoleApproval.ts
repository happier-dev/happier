import { sameStrictJsonValue, projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { SessionSpawnNewActionInputV2Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { MachineSetupPlanResultV1Schema } from '../../machines/managed/actionsV1.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { formatQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { readExplicitActionApprovalPreferenceV1, resolveActionApprovalRouting } from '../actionApprovalPolicy.js';
import { resolveApprovalSurface } from '../actionApprovalSurface.js';
import { SESSION_SPAWN_NEW_ACTION_ID_V1, type ActionId } from '../actionIds.js';
import { getActionSpec, type ActionSpec } from '../actionSpecs.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { readActionApprovalScopeAdmissionV1 } from './approvalScope.js';
import type { ActionHomeEquivalence, PreparedCoreAdmission } from './coreInvocation.js';
import type { ActionApprovalScopeV1, ActionSettingsActionId } from '../actionSettings.js';
import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure, ActionExecuteResult, HostReviewedChildrenPlanV1, HostReviewedChildrenPreparationV1, HostReviewedChildInvocationV1 } from './types.js';
import { isHostAdmittedReviewedChildPolicyV1, readHostAdmittedReviewedChildV1, readHostReviewedChildOperationV1, retainHostReviewedChildCredentialScopeAdmissionV1, type HostReviewedChildPolicyV1 } from './deploymentRoleChild.js';
import { HostReviewedChildrenPlanV1Schema } from './hostReviewedChildrenV1.js';

/** Stored review facts are closed; they never create a host invocation port. */
export function readHostReviewedChildrenPlanV1(value: unknown): HostReviewedChildrenPlanV1 | undefined {
  const parsed = HostReviewedChildrenPlanV1Schema.safeParse(value);
  return parsed.success && parsed.data.children.length > 0 ? parsed.data : undefined;
}
/** Resolve demanded child policy once at the parent's natural preparation boundary. */
export function prepareHostReviewedChildPolicyV1(child: HostReviewedChildrenPlanV1['children'][number],
  context: ActionExecutorContext, approvalScope?: ActionApprovalScopeV1, reviewAdmitted = false,
  defaultSafety?: ActionSpec['safety']): (HostReviewedChildPolicyV1 & Readonly<{ requiredActionIds: readonly string[] }>) | null {
  const settings = context.actionsSettings;
  const surface = resolveApprovalSurface(context);
  if (!settings || surface.kind === 'ambiguous') return null;
  if (typeof child.action !== 'string' && context.approvalProfileId && defaultSafety === undefined) return null;
  const candidateIds: readonly ActionSettingsActionId[] = typeof child.action === 'string'
    ? [child.action] : ['action.invoke', formatQualifiedPluginActionId(child.action)];
  return { action: child.action, role: child.role, surface: surface.surface,
    requiredActionIds: candidateIds.filter(id => typeof child.action === 'string'
      ? resolveActionApprovalRouting({ actionId: child.action, spec: getActionSpec(child.action),
        input: child.input === undefined ? child.scopeInput : child.input,
        context: { ...context, bypassApprovals: false }, settings, reviewAdmitted, ...(approvalScope ? { approvalScope } : {}) }).required
      : resolveActionApprovalRouting({ actionId: 'action.invoke', profileActionId: id, spec: getActionSpec('action.invoke'),
        ...(defaultSafety ? { defaultSafety } : {}),
        input: child.input === undefined ? child.scopeInput : child.input,
        context: { ...context, bypassApprovals: false }, settings, reviewAdmitted,
        requiredByPolicy: readExplicitActionApprovalPreferenceV1(id, settings, context, approvalScope) === true,
        ...(approvalScope ? { approvalScope } : {}) }).required) };
}

/** Prepare demanded effects once; prepared dispatch retains this exact admission. */
export async function prepareHostReviewedChildrenV1(params: Readonly<{
  actionId: ActionId; input: unknown; context: ActionExecutorContext; deps: ActionExecutorDeps;
  declaredChildren?: HostReviewedChildrenPlanV1['children'];
  /** The root's exact native confirmation answers demanded defaults, never explicit Require. */
  reviewAdmitted?: boolean;
  approvalScope?: ActionApprovalScopeV1;
  existing?: PreparedCoreAdmission; approvalReplay: boolean; isSameHome: ActionHomeEquivalence;
  invokePreparationChild(child: HostReviewedChildInvocationV1): Promise<ActionExecuteResult>;
  admitChildCredentialScope(child: HostReviewedChildInvocationV1): Promise<ActionExecuteFailure | null>;
}>): Promise<Readonly<{ plan?: HostReviewedChildrenPlanV1; policies?: readonly HostReviewedChildPolicyV1[];
  input?: HostReviewedChildrenPreparationV1['input'];
  executeAdmittedAction?: HostReviewedChildrenPreparationV1['executeAdmittedAction'];
  prepareExecutionContext?: HostReviewedChildrenPreparationV1['prepareExecutionContext'];
  approvalPreview?: HostReviewedChildrenPreparationV1['approvalPreview'];
  admittedReviewedChild?: true;
  reviewRequired: boolean }> | ActionExecuteResult> {
  const { actionId, context, deps, existing } = params;
  if (existing) return { plan: existing.hostReviewedChildren, policies: existing.hostReviewedChildPolicies,
    ...(existing.prepareExecutionContext ? { prepareExecutionContext: existing.prepareExecutionContext } : {}),
    ...(existing.admittedReviewedChild ? { admittedReviewedChild: true } : {}),
    ...(existing.executeAdmittedAction ? { executeAdmittedAction: existing.executeAdmittedAction } : {}), reviewRequired: false };
  const reviewedChild = readHostReviewedChildOperationV1(context, actionId, params.input);
  const admittedLeaf = readHostAdmittedReviewedChildV1(context);
  // The exact admitted child consumes its original closed plan, not another preparation or review.
  if (isHostAdmittedReviewedChildPolicyV1(reviewedChild, actionId, params.input)
    || admittedLeaf?.actionId === actionId && sameStrictJsonValue(admittedLeaf.input, params.input))
    return { admittedReviewedChild: true, reviewRequired: false };
  // A private-schema host original is still original work.
  const machineRuntimeDemand = reviewedChild ? null
    : getActionSpec(actionId).machineRuntimeDemandForInput?.(params.input, context);
  const prepared = actionId === 'template.instantiate' && deps.prepareBotTemplateInstantiation
    ? await deps.prepareBotTemplateInstantiation({ input: params.input,
      invokeChild: params.invokePreparationChild,
      context: { ...context, runActionOperation: context.runActionOperation ?? deps.runActionOperation } })
    : actionId === 'template.release' && deps.prepareBotTemplateRelease
      ? await deps.prepareBotTemplateRelease({ input: params.input, context })
    : actionId === 'template.updates.apply' && deps.prepareBotTemplateUpdate
      ? await deps.prepareBotTemplateUpdate({ input: params.input,
        invokeChild: params.invokePreparationChild,
        context: { ...context, runActionOperation: context.runActionOperation ?? deps.runActionOperation } })
    : await deps.prepareHostReviewedChildren?.({ actionId, input: params.input, context,
      ...(machineRuntimeDemand ? { machineRuntimeDemand } : {}) });
  if (prepared && 'ok' in prepared) return prepared;
  let approvalPreview = prepared?.approvalPreview;
  const setup = actionId === SESSION_SPAWN_NEW_ACTION_ID_V1
    ? SessionSpawnNewActionInputV2Schema.parse(params.input).machineSetupPlanInput : undefined;
  if (setup) {
    if (!deps.machineSetupPlan) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    const result = await deps.machineSetupPlan({ input: { ...setup, mode: 'effects' }, context, signal: context.signal });
    const failure = readActionFailureEnvelope(result);
    if (failure) return failure;
    const plan = MachineSetupPlanResultV1Schema.safeParse(result);
    if (!plan.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    approvalPreview = projectNativeJsonValueForTransport({
      ...(approvalPreview === undefined ? {} : { preparation: approvalPreview }), machineSetup: plan.data,
    });
  }
  const declarations = prepared || params.declaredChildren ? {
    children: [...(prepared?.children ?? []), ...(params.declaredChildren ?? [])],
  } : undefined;
  const plan = declarations ? readHostReviewedChildrenPlanV1(declarations) : undefined;
  if (declarations && declarations.children.length > 0 && !plan) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  const policies: HostReviewedChildPolicyV1[] = [];
  for (const child of plan?.children ?? []) {
    // Concrete demanded effects are admitted before any parent effect or Ask.
    // Dynamic operands remain at their existing dispatch-time target boundary.
    if (child.input !== undefined) {
      const failure = await params.admitChildCredentialScope({ action: child.action, role: child.role, input: child.input });
      if (failure) return failure;
    }
    const childId = typeof child.action === 'string' ? child.action : 'action.invoke';
    const operand = child.input === undefined ? child.scopeInput : child.input;
    const input = typeof child.action === 'string' ? operand : { action: child.action, input: operand };
    const scope = operand === undefined ? { approvalScope: params.approvalScope }
      : await readActionApprovalScopeAdmissionV1({ actionId: childId, spec: getActionSpec(childId), input,
      context, deps, phase: params.approvalReplay ? 'replay' : 'prepare', isSameHome: params.isSameHome });
    if ('ok' in scope) return scope;
    const qualifiedId = typeof child.action === 'string' ? null : formatQualifiedPluginActionId(child.action);
    const defaultSafety = qualifiedId && context.approvalProfileId
      ? deps.listContributedActionDefinitions?.({ id: qualifiedId }).find(definition => definition.id === qualifiedId)?.safety
      : undefined;
    const policy = prepareHostReviewedChildPolicyV1(child, context, scope.approvalScope, params.reviewAdmitted, defaultSafety);
    if (!policy) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    policies.push(child.input !== undefined ? retainHostReviewedChildCredentialScopeAdmissionV1(policy, context) : policy);
  }
  const witness = context.presentUserApproval;
  const retained = params.approvalReplay || witness?.actionId === actionId
    ? context.approvedActionReplay?.hostReviewedChildren : undefined;
  // Private replay already claimed the exact accepted Artifact decision. It
  // covers this retained plan without turning automation into person consent.
  const reviewAccepted = Boolean(plan && retained && sameStrictJsonValue(plan, retained)
    && (params.approvalReplay || context.approvedActionReplay && witness
      && witness.artifactId === context.approvedActionReplay.artifactId && witness.actionId === actionId
      && witness.requestId === context.actionRequestId && witness.decidingAccountId
      && witness.inputDigest === computeActionInputApprovalDigestV1(actionId, params.input)));
  if (retained && !reviewAccepted || params.approvalReplay && plan && !reviewAccepted)
    return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
  return { ...(plan ? { plan, policies } : {}),
    ...(prepared?.input === undefined ? {} : { input: prepared.input }),
    ...(prepared?.prepareExecutionContext ? { prepareExecutionContext: prepared.prepareExecutionContext } : {}),
    ...(approvalPreview === undefined ? {} : { approvalPreview }),
    ...(prepared?.executeAdmittedAction ? { executeAdmittedAction: prepared.executeAdmittedAction } : {}),
    reviewRequired: !reviewAccepted && policies.some(policy => (policy.requiredActionIds?.length ?? 0) > 0) };
}
