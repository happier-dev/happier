import { normalizeStrictJsonValue, projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '../../json/strictJsonValue.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { isDeploymentChildRootActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import type { WorkflowApprovedOperationV1 } from '../approvedOperationV1.js';
import type { ActionId } from '../actionIds.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import type { ExternalActionExecutionAuthorizationV1, ReviewedActionChildHttpProofV1 } from '../externalActionApi.js';
import type { SocketRpcMachineAdmissionContextV1 } from '../../rpc/socket.js';
import type { ActionExecutorContext, ActionExecuteResult, ActionExecuteFailure,
  HostReviewedChildPortV1, HostReviewedChildInvocationV1, HostReviewedChildrenPlanV1 } from './types.js';

const deploymentRoleChild = Symbol('deploymentRoleChild');
type ReviewedOperation = Pick<WorkflowApprovedOperationV1, 'parent' | 'steps'> & Readonly<{ [deploymentRoleChild]?: true }>;
type RootActionId = 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown' | 'deployments.cancel';
export type HostReviewedChildPolicyV1 = Readonly<{
  action: HostReviewedChildInvocationV1['action'];
  role: string;
  /** Preparation lists Require choices; an authenticated admitted continuation need not repeat them. */
  requiredActionIds?: readonly string[];
  surface: NonNullable<ActionExecutorContext['surface']>;
}>;
export type HostReviewedChildV1 = Readonly<{
  action: HostReviewedChildInvocationV1['action'];
  role: string;
  input: JsonValue;
}>;
export type HostReviewedParentV1 = ReviewedOperation['parent'];
type ChildProof = Readonly<{
  rootActionId: string;
  signal?: AbortSignal;
  qualifiedActionId: string;
  envelope?: Readonly<Record<string, JsonValue>> & Readonly<{
    action: Readonly<{ pluginId: string; localId: string }>;
    input?: JsonValue;
  }>;
  input: JsonValue;
  operation: ReviewedOperation;
  reviewedChild?: ReviewedActionChildHttpProofV1;
  environmentId?: string;
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
}>;
type ChildContext = ActionExecutorContext & { [deploymentRoleChild]?: ChildProof };
type ReviewedChildPort = HostReviewedChildPortV1 & Readonly<{ [deploymentRoleChild]?: true }>;

function readProof(context: ActionExecutorContext | undefined, actionId: string, input?: unknown, discovery = false): ChildProof | null {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  if (!context || !proof || typeof proof !== 'object'
    || context.signal?.aborted || proof.signal?.aborted) return null;
  if (actionId === 'action.invoke' && proof.envelope) return sameStrictJsonValue(input, proof.envelope) ? proof : null;
  return actionId === proof.qualifiedActionId && (discovery && input === undefined
    || sameStrictJsonValue(input, proof.input)) ? proof : null;
}

/** In-process host evidence; a serialized requester/token carrier alone never admits child work. Not a plugin sandbox. */
export function readHostReviewedChildOperationV1(context: ActionExecutorContext | undefined, actionId: string,
  input?: unknown): ReviewedOperation | null {
  return readProof(context, actionId, input)?.operation ?? null;
}

/** The issuer records the admitted policy once; serialized data cannot carry it. */
export function isHostAdmittedReviewedChildPolicyV1(operation: ReviewedOperation | null | undefined,
  actionId: string, input: unknown): boolean {
  if (operation?.[deploymentRoleChild] !== true) return false;
  const contributed = parseQualifiedPluginActionId(actionId);
  return operation.steps.some(step => step.actionId === actionId && sameStrictJsonValue(step.input, input)
      || contributed && step.actionId === 'action.invoke'
        && sameStrictJsonValue(step.input.action, contributed)
        && sameStrictJsonValue(step.input.input ?? null, input));
}

/** Original reviewed operation facts, not a credential or transported proof. */
export function readHostReviewedParentV1(context: ActionExecutorContext | undefined): HostReviewedParentV1 | null {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  return proof?.operation[deploymentRoleChild] === true
    ? proof.operation.parent : context?.hostReviewedChild?.parent ?? null;
}

/** The existing issuer's private port, not its serializable parent projection, carries admission. */
export function readHostAdmittedReviewedParentV1(port: HostReviewedChildPortV1 | undefined): HostReviewedParentV1 | null {
  const admitted: ReviewedChildPort | undefined = port;
  return admitted?.[deploymentRoleChild] === true ? admitted.parent ?? null : null;
}

/** The root credential ceiling and its Environment remain the sole grant authority. */
export function readDeploymentRoleRootInputV1(context: ActionExecutorContext, actionId: string,
  input: unknown, hostInternal: boolean, discovery = false): Readonly<{ actionId: RootActionId; environmentId: string }> | null {
  const proof = hostInternal ? readProof(context, actionId, input, discovery) : null;
  return proof?.environmentId && (isDeploymentChildRootActionIdV1(proof.rootActionId)
    || proof.rootActionId === 'deployments.teardown' || proof.rootActionId === 'deployments.cancel')
    ? { actionId: proof.rootActionId as RootActionId, environmentId: proof.environmentId } : null;
}

/** Live parents lend their ceiling; independently Home-bound children retain their own. */
export function readHostReviewedChildRootV1(context: ActionExecutorContext, actionId: string,
  input: unknown, discovery = false): HostReviewedParentV1 | null {
  const proof = readProof(context, actionId, input, discovery);
  // A Run can carry reviewed parent consent while Home independently binds
  // this child request. Its existing child credential remains the ceiling.
  if (proof && context.externalActionExecutionAuthorization?.binding.actionId
    && context.externalActionExecutionAuthorization.binding.actionId !== proof.rootActionId) return null;
  return proof?.operation.parent ?? null;
}

/** Physical custody is independently admitted; the original SOURCE root stays unchanged. */
export function readHostReviewedChildReceivingAdmissionV1(context: ActionExecutorContext | undefined): SocketRpcMachineAdmissionContextV1 | null {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  if (!context || !proof || typeof proof !== 'object'
    || context.signal?.aborted || proof.signal?.aborted) return null;
  return proof?.receivingAdmission ?? null;
}

/** The existing issuer's exact admitted operand for signed child transports. */
export function readHostAdmittedReviewedChildV1(context: ActionExecutorContext | undefined):
  (ReviewedActionChildHttpProofV1 & Readonly<{ input: JsonValue }>) | null {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  if (!proof?.reviewedChild || proof.operation[deploymentRoleChild] !== true
    || !readProof(context, proof.qualifiedActionId, proof.input)) return null;
  return { ...proof.reviewedChild, input: proof.input };
}

/** Single in-process issuer. Domain adapters supply admitted, normalized facts. */
export async function invokeHostReviewedChildV1<T = ActionExecuteResult>(params: Readonly<{
  parent: HostReviewedParentV1;
  context: ActionExecutorContext;
  child: HostReviewedChildV1;
  invocationServices?: HostReviewedChildInvocationV1['invocationServices'];
  /** Supplied only by the receiving custody/placement owner after ordinary admission. */
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
  admittedReview?: HostReviewedChildPolicyV1;
  environmentId?: string;
  execute(input: unknown, context: ActionExecutorContext, actionId: ActionId): Promise<T>;
}>): Promise<T | ActionExecuteFailure> {
  const denied = (): ActionExecuteFailure => ({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  const { context } = params;
  const { child, parent } = params;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const receiving = params.receivingAdmission;
  if (!parent.actionId
    || context.signal?.aborted
    || receiving && (!binding || receiving.actorAccountId !== binding.accountId
      || receiving.actorAccountId !== context.runtimeAccountId)
    // The domain admission owns the relationship between reviewed parent and
    // request: SOURCE/receipt roots or an independently Home-bound Run child.
    || binding && (binding.accountId !== context.runtimeAccountId
      || !sameStrictJsonValue(context.externalActionTarget, binding.target))) return denied();
  const childInput = normalizeStrictJsonValue(child.input);
  const parentInput = normalizeStrictJsonValue(parent.input);
  if (!parentInput || typeof parentInput !== 'object' || Array.isArray(parentInput)) return denied();
  const action = typeof child.action === 'string' ? child.action : { ...child.action };
  const invocation = action === 'action.invoke'
    ? PluginContributionIdentityV1Schema.safeParse(readRecord(childInput).action) : undefined;
  if (invocation && !invocation.success) return denied();
  const envelope: ChildProof['envelope'] = typeof action === 'string'
    ? invocation?.success ? { ...(childInput as Record<string, JsonValue>), action: invocation.data } : undefined
    : { action, input: childInput };
  if (!envelope && (!childInput || typeof childInput !== 'object' || Array.isArray(childInput))) return denied();
  const qualifiedActionId = envelope ? formatQualifiedPluginActionId(envelope.action) : action as ActionId;
  const proofInput = envelope ? envelope.input ?? null : childInput;
  const reviewedChild = params.admittedReview && binding?.actionId === parent.actionId
    ? Object.freeze({ actionId: qualifiedActionId, role: child.role,
      inputDigest: computeActionInputApprovalDigestV1(qualifiedActionId as ActionId, proofInput) }) : undefined;
  const proof: ChildProof = {
    rootActionId: parent.actionId, qualifiedActionId, input: proofInput,
    ...(reviewedChild ? { reviewedChild } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(envelope ? { envelope } : {}),
    ...(params.environmentId ? { environmentId: params.environmentId } : {}),
    ...(receiving ? { receivingAdmission: structuredClone(receiving) } : {}),
    operation: {
      ...(params.admittedReview ? { [deploymentRoleChild]: true as const } : {}),
      parent: { actionId: parent.actionId, input: parentInput as Record<string, JsonValue> },
      // Contributed operands can be any JSON value. Keep their single ordinary
      // Action envelope, not a scalar cast into the stored Workflow record shape.
      steps: envelope ? [{ actionId: 'action.invoke', input: envelope }]
        : [{ actionId: qualifiedActionId, input: childInput as Record<string, JsonValue> }],
    },
  };
  const childContext: ChildContext = { ...context, bypassApprovals: false,
    hostReviewedChild: undefined, invocationServices: params.invocationServices, [deploymentRoleChild]: proof };
  const authorization = context.externalActionExecutionAuthorization;
  const http = authorization?.requesterHttpProjection;
  // Independently Home-bound Run children keep their own incumbent ceiling.
  if (reviewedChild && authorization && http) {
    const childAuthorization: ExternalActionExecutionAuthorizationV1 = { ...authorization };
    Object.defineProperties(childAuthorization, {
      ...Object.getOwnPropertyDescriptors(authorization),
      requesterHttpProjection: { value: Object.freeze({ ...http,
        createRequestHeaders: async (request: Parameters<typeof http.createRequestHeaders>[0]) =>
          readProof(childContext, qualifiedActionId, proof.input)
            ? http.createRequestHeaders({ ...request, effectActionId: qualifiedActionId, reviewedChild }) : null,
      }), enumerable: false },
    });
    Object.defineProperty(childContext, 'externalActionExecutionAuthorization', {
      value: Object.freeze(childAuthorization), enumerable: true,
    });
  }
  return await params.execute(envelope ?? childInput, childContext, typeof action === 'string' ? action : 'action.invoke');
}

/** One host port; domain owners supply concrete child input after their ordinary admission. */
export function createHostReviewedChildPortV1(params: Readonly<{
  actionId: string; input: unknown; context: ActionExecutorContext;
  plan?: HostReviewedChildrenPlanV1;
  policies?: readonly HostReviewedChildPolicyV1[];
  reviewAdmitted?: true;
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
  execute(input: unknown, context: ActionExecutorContext, actionId: ActionId): Promise<ActionExecuteResult>;
}>): HostReviewedChildPortV1 {
  const plan = params.plan;
  const parent = { actionId: params.actionId, input: projectNativeJsonValueForTransport(params.input) as Record<string, JsonValue> };
  const parentInput = readRecord(parent.input);
  const environmentId = (isDeploymentChildRootActionIdV1(params.actionId) || params.actionId === 'deployments.teardown'
    || params.actionId === 'deployments.cancel') && typeof parentInput.environmentId === 'string' ? parentInput.environmentId : undefined;
  const denied = (): ActionExecuteResult => ({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  const port: ReviewedChildPort = {
    ...(params.reviewAdmitted ? { parent, [deploymentRoleChild]: true as const } : {}),
    ...(plan ? { preparedChildren: plan.children.flatMap(child => child.input === undefined ? []
      : [{ action: child.action, role: child.role, input: child.input }]) } : {}),
    invoke: async request => {
      if (!plan) return denied();
      const matches = plan.children.flatMap((child, index) => child.role === request.role
        && sameStrictJsonValue(child.action, request.action)
        && (child.input === undefined || sameStrictJsonValue(child.input, request.input))
        && (child.scopeInput === undefined || Object.entries(child.scopeInput)
          .every(([key, value]) => sameStrictJsonValue(readRecord(request.input)[key], value))) ? [index] : []);
      if (matches.length !== 1) return denied();
      return invokeHostReviewedChildV1({ parent, context: params.context,
        child: { action: request.action, role: request.role, input: request.input },
        ...(request.invocationServices ? { invocationServices: request.invocationServices } : {}),
        ...(params.receivingAdmission ? { receivingAdmission: params.receivingAdmission } : {}),
        ...(environmentId ? { environmentId } : {}),
        admittedReview: params.policies?.[matches[0]!],
        execute: (input, context, actionId) => params.execute(input, { ...context, hostReviewedChild: port }, actionId) });
    },
  };
  return port;
}
