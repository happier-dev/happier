import { normalizeStrictJsonValue, projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '../../json/strictJsonValue.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { isDeploymentChildEffectActionIdV1, isDeploymentDomainAddActionIdV1, deploymentOperationForRootActionV1,
  DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
  DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1, DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1,
  DEPLOYMENT_DATABASE_READ_ACCESS_BINDINGS_CHILD_ROLE_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { DeploymentBindingsPatchInputV1Schema } from '../../deployments/deploymentBindingPatchV1.js';
import { projectDeploymentReadAdmissionV1, readDeploymentDatabaseReadAccessBindingChildV1 } from '../../deployments/deploymentReadAdmissionV1.js';
import { DeploymentSecretBindingSourceV1Schema } from '../../deployments/storedAppInputV1.js';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1, isManagedOpaquePresetReviewedChildRootActionV1 } from '../../machines/managed/actionIdsV1.js';
import { projectDeploymentNativeAdmissionV1, isDeploymentDomainNativeAdmissionV1,
  isDeploymentBackupConfigureNativeAdmissionV1, isDeploymentTelemetryNativeAdmissionV1, type DeploymentNativeAdmissionV1 } from '../../deployments/deploymentCandidatePublicationV1.js';
import type { ActionEnvironmentApprovalScopeAdmissionV1 } from '../actionApprovalPolicy.js';
import type { WorkflowApprovedOperationV1 } from '../approvedOperationV1.js';
import { ActionIdSchema, type ActionId } from '../actionIds.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { isPresentUserHostInvocation } from '../invocationAuthority.js';
import { readAuthenticatedActionRequesterAccountIdV1 } from '../actionRequestAttributionV1.js';
import { readExternalActionBindingAuthority } from '../externalActionBindingAuthority.js';
import { isBackupReceiverSetupChildOperandV1 } from '../../machines/peer/mediation/rpc/reviewedChildFamilyV1.js';
import { deriveBackupReceiverSetupRunIdV1 } from '../../workflows/workflowInvocationIdentityV1.js';
import type { ExternalActionExecutionAuthorizationV1, ReviewedActionChildHttpProofV1 } from '../externalActionApi.js';
import type { SocketRpcMachineAdmissionContextV1 } from '../../rpc/socket.js';
import type { ApiTokenGrantV1 } from '../../auth/apiTokenGrant.js';
import { readTeamCredentialActionHttpPurposeV1 } from '../../teams/credentials/actionHttpPurposeV1.js';
import { DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1, selectDeploymentReviewedChildPlanV1 } from '../specs/deploymentPreparationScope.js';
import type { ActionExecutorContext, ActionExecuteResult, ActionExecuteFailure,
  HostReviewedChildPortV1, HostReviewedChildInvocationV1, HostReviewedChildrenPlanV1 } from './types.js';

const deploymentRoleChild = Symbol('deploymentRoleChild');
const credentialScopeAdmission = Symbol('credentialScopeAdmission');
const reviewedChildPlan = Symbol('reviewedChildPlan');

function reviewedChildScopeDenied(reason: 'issuer_binding' | 'issuer_target' | 'aborted' | 'child_mismatch' | 'no_plan',
  policy?: Readonly<{ requiredActionIds: readonly string[]; surface: HostReviewedChildPolicyV1['surface'];
    requestedSurface: ActionExecutorContext['surface'] }>): ActionExecuteFailure {
  return { ok: false, errorCode: 'credential_scope_denied',
    error: policy ? `Approval required by ${policy.requiredActionIds.join(', ')}; required surface: ${policy.surface}; requested surface: ${policy.requestedSurface}.`
      : 'credential_scope_denied',
    failureCause: { phase: 'deployment.reviewed_child', errorClass: 'Error',
      errorCode: policy ? 'approval_required' : reason, httpStatus: null } };
}
type ReviewedOperation = Pick<WorkflowApprovedOperationV1, 'parent' | 'steps'> & Readonly<{
  approvedBy?: WorkflowApprovedOperationV1['approvedBy'];
  approvedRequestId?: string;
  [deploymentRoleChild]?: true;
}>;
type RootActionId = 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown' | 'deployments.cancel' | 'deployments.receipts.observe' | 'deployments.logs.read';
/**
 * Host-only facts from Home's opaque managed admission. They never cross an
 * Action boundary: the signed root still owns requester identity and target.
 */
export type ManagedOpaquePresetCustodianAdmissionV1 = Readonly<{
  homeId: string;
  custodianAccountId: string;
  requestId: string;
  controller: Readonly<{ machineId: string; installationId: string }>;
}>;
type ManagedOpaquePresetCustodianProof = ManagedOpaquePresetCustodianAdmissionV1 & Readonly<{
  requesterAccountId: string;
  target: unknown;
}>;
export type HostReviewedChildPolicyV1 = Readonly<{
  action: HostReviewedChildInvocationV1['action'];
  role: string;
  /** Preparation lists Require choices; an authenticated admitted continuation need not repeat them. */
  requiredActionIds?: readonly string[];
  surface: NonNullable<ActionExecutorContext['surface']>;
  /** Host-private concrete credential admission; omitted by the wire policy schema. */
  [credentialScopeAdmission]?: Readonly<{ grant: ApiTokenGrantV1; target: ActionExecutorContext['externalActionTarget'] }>;
}>;
export type HostReviewedChildV1<TAction extends ActionId = ActionId> = Readonly<{
  action: TAction | Exclude<HostReviewedChildInvocationV1['action'], ActionId>;
  role: string;
  input: JsonValue;
}>;
export type HostReviewedParentV1 = ReviewedOperation['parent'];
type EnvironmentApprovalScope = NonNullable<ActionEnvironmentApprovalScopeAdmissionV1['scope']>;
type ChildProof = Readonly<{
  /** Exact admitted caller retained by the issuer when it dispatches a nested child. */
  parentProof?: ChildProof;
  rootActionId?: string;
  role?: string;
  signal?: AbortSignal;
  qualifiedActionId: string;
  envelope?: Readonly<Record<string, JsonValue>> & Readonly<{
    action: Readonly<{ pluginId: string; localId: string }>;
    input?: JsonValue;
  }>;
  input: JsonValue;
  operation?: ReviewedOperation;
  [deploymentRoleChild]?: true;
  reviewedChild?: ReviewedActionChildHttpProofV1;
  originalAuthorization?: ExternalActionExecutionAuthorizationV1;
  childAuthorization?: ExternalActionExecutionAuthorizationV1;
  environmentId?: string;
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
  environmentApprovalScope?: EnvironmentApprovalScope;
  [credentialScopeAdmission]?: HostReviewedChildPolicyV1[typeof credentialScopeAdmission];
}>;
type ChildContext = ActionExecutorContext & { [deploymentRoleChild]?: ChildProof };
type ReviewedChildPort = HostReviewedChildPortV1 & Readonly<{ [deploymentRoleChild]?: true;
  /** The admitted parent's own prepared children and policies, read only in-process. */
  [reviewedChildPlan]?: Readonly<{ plan: HostReviewedChildrenPlanV1; policies?: readonly HostReviewedChildPolicyV1[] }> }>;

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
  const operation = readProof(context, actionId, input)?.operation;
  if (operation) return operation;
  if (!context || context.signal?.aborted) return null;
  const parent = readHostAdmittedReviewedParentV1(context.hostReviewedChild);
  if (parent?.actionId !== 'action.invoke') return null;
  const admitted: ReviewedOperation = { parent,
    steps: [{ actionId: parent.actionId, input: parent.input }], [deploymentRoleChild]: true };
  return isHostAdmittedReviewedChildPolicyV1(admitted, actionId, input) ? admitted : null;
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

/** Scope projected from the Environment already read by the database setup owner. */
export function readHostReviewedChildEnvironmentApprovalScopeV1(context: ActionExecutorContext, actionId: ActionId,
  input: unknown): EnvironmentApprovalScope | undefined {
  return readProof(context, actionId, input)?.environmentApprovalScope;
}

/** Original reviewed operation facts, not a credential or transported proof. */
export function readHostReviewedParentV1(context: ActionExecutorContext | undefined): HostReviewedParentV1 | null {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  return proof?.operation?.[deploymentRoleChild] === true
    ? proof.operation.parent : context?.hostReviewedChild?.parent ?? null;
}

/** Root purpose survives nesting; it does not admit the pending leaf operand. */
export function readHostAdmittedReviewedRootV1(context: ActionExecutorContext | undefined): HostReviewedParentV1 | null {
  const current = (context as ChildContext | undefined)?.[deploymentRoleChild];
  if (!current || !readProof(context, current.qualifiedActionId, current.input)
    || context?.externalActionExecutionAuthorization
      && context.externalActionExecutionAuthorization.binding.actionId !== current.rootActionId) return null;
  let proof = current;
  while (proof.parentProof) proof = proof.parentProof;
  return proof.operation?.[deploymentRoleChild] === true ? proof.operation.parent : null;
}

/** The existing issuer's private port, not its serializable parent projection, carries admission. */
export function readHostAdmittedReviewedParentV1(port: HostReviewedChildPortV1 | undefined): HostReviewedParentV1 | null {
  const admitted: ReviewedChildPort | undefined = port;
  return admitted?.[deploymentRoleChild] === true ? admitted.parent ?? null : null;
}

/**
 * The admitted parent already prepared and reviewed the children it listed.
 * A later issuer of the same child consumes that decision instead of
 * deciding it again; null means the parent did not list exactly this child.
 */
export function readHostAdmittedReviewedChildPlanV1(port: HostReviewedChildPortV1 | undefined,
  child: Pick<HostReviewedChildV1, 'action' | 'role'>): Readonly<{
    child: HostReviewedChildrenPlanV1['children'][number]; policy?: HostReviewedChildPolicyV1 }> | null {
  const admitted: ReviewedChildPort | undefined = port;
  const prepared = admitted?.[deploymentRoleChild] === true ? admitted[reviewedChildPlan] : undefined;
  const indexes = prepared?.plan.children.flatMap((candidate, index) => candidate.role === child.role
    && sameStrictJsonValue(candidate.action, child.action) ? [index] : []) ?? [];
  if (!prepared || indexes.length !== 1) return null;
  const policy = prepared.policies?.[indexes[0]!];
  return { child: prepared.plan.children[indexes[0]!]!, ...(policy ? { policy } : {}) };
}

/** The root credential ceiling and its Environment remain the sole grant authority. */
export function readDeploymentRoleRootInputV1(context: ActionExecutorContext, actionId: string,
  input: unknown, hostInternal: boolean, discovery = false): Readonly<{ actionId: RootActionId; environmentId: string }> | null {
  const proof = hostInternal ? readProof(context, actionId, input, discovery) : null;
  return proof?.rootActionId && proof.environmentId
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
  return proof ? readHostAdmittedReviewedRootV1(context) ?? proof.operation?.parent ?? null : null;
}

/** Spend this invocation's exact prepared scope admission; public context cannot supply the symbol proof. */
export function hasHostReviewedChildCredentialScopeAdmissionV1(context: ActionExecutorContext, actionId: string,
  input: unknown, discovery = false): boolean {
  const proof = readProof(context, actionId, input, discovery);
  const admission = proof?.[credentialScopeAdmission];
  return Boolean(proof && admission && admission.grant === context.externalActionCredential?.grant
    && sameStrictJsonValue(admission.target ?? null, context.externalActionTarget ?? null)
    && (!context.externalActionExecutionAuthorization
      || context.externalActionExecutionAuthorization.binding.actionId === proof.rootActionId));
}

/** Retain the credential owner's admitted fact on this private policy, never its JSON projection. */
export function retainHostReviewedChildCredentialScopeAdmissionV1(policy: HostReviewedChildPolicyV1,
  context: ActionExecutorContext): HostReviewedChildPolicyV1 {
  const grant = context.externalActionCredential?.grant;
  return grant ? { ...policy, [credentialScopeAdmission]: { grant,
    target: context.externalActionTarget ? structuredClone(context.externalActionTarget) : undefined } } : policy;
}

function matchesManagedOpaquePresetCustodianProof(proof: ManagedOpaquePresetCustodianProof | undefined,
  parent: Readonly<{ actionId: string; input: unknown }>, context: ActionExecutorContext,
  binding: NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']>['binding'] | undefined): boolean {
  const child = binding?.actionId === parent.actionId ? null : readProof(context, parent.actionId, parent.input);
  const admittedChild = child?.rootActionId === binding?.actionId
    && isHostAdmittedReviewedChildPolicyV1(child?.operation, parent.actionId, parent.input);
  if (!proof || !binding || !isManagedOpaquePresetReviewedChildRootActionV1(parent.actionId)
    || (binding.actionId !== parent.actionId && !admittedChild)
    || binding.accountId !== proof.requesterAccountId
    || binding.custodianAccountId !== proof.custodianAccountId
    || context.runtimeAccountId !== proof.requesterAccountId
    || context.actionRequestId !== proof.requestId
    || binding.requestId !== (admittedChild ? context.originalActionEnvelope?.requestId : proof.requestId)
    || binding.serverIdentityId !== proof.homeId
    || binding.machineId !== proof.controller.machineId
    || binding.installationId !== proof.controller.installationId
    || binding.target.kind !== 'machine'
    || binding.target.machineId !== proof.controller.machineId
    || !sameStrictJsonValue(context.externalActionTarget, binding.target)
    || !sameStrictJsonValue(proof.target, binding.target)) return false;
  return true;
}

/**
 * Admit the opaque-preset child policy against Home's exact custody scope.
 * The signed root retains requester and controller identity; the receiving
 * transport owns placement admission.
 */
export function retainManagedOpaquePresetCustodianAdmissionV1(policy: HostReviewedChildPolicyV1,
  params: Readonly<{ parent: Readonly<{ actionId: string; input: unknown }>; context: ActionExecutorContext;
    admission: ManagedOpaquePresetCustodianAdmissionV1 }>): HostReviewedChildPolicyV1 | null {
  const binding = params.context.externalActionExecutionAuthorization?.binding;
  if (!binding || !matchesManagedOpaquePresetCustodianProof({ ...params.admission,
    requesterAccountId: binding.accountId, target: binding.target }, params.parent, params.context, binding)) return null;
  return policy;
}

/** Physical custody is independently admitted; the original SOURCE root stays unchanged. */
export function readHostReviewedChildReceivingAdmissionV1(context: ActionExecutorContext | undefined): SocketRpcMachineAdmissionContextV1 | null {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  if (!context || !proof || typeof proof !== 'object'
    || context.signal?.aborted || proof.signal?.aborted) return null;
  return proof?.receivingAdmission ?? null;
}

/** Local and signed children expose the same already-admitted private role. */
export function readHostAdmittedReviewedChildRoleV1(context: ActionExecutorContext | undefined,
  actionId: string, input: unknown): string | null {
  const proof = readProof(context, actionId, input);
  if (!proof || (proof.operation?.[deploymentRoleChild] !== true && proof[deploymentRoleChild] !== true)) return null;
  return proof.role ?? proof.reviewedChild?.role ?? null;
}

/** The existing issuer's exact admitted operand for signed child transports. */
export function readHostAdmittedReviewedChildV1(context: ActionExecutorContext | undefined):
  (ReviewedActionChildHttpProofV1 & Readonly<{ input: JsonValue }>) | null {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  if (!proof?.reviewedChild || (proof.operation?.[deploymentRoleChild] !== true && proof[deploymentRoleChild] !== true)
    || !readProof(context, proof.qualifiedActionId, proof.input)) return null;
  return { ...proof.reviewedChild, input: proof.input };
}

/** Project the issuer's admitted person review onto its exact native child intent. */
export function readHostReviewedChildPresentUserApprovalV1(context: ActionExecutorContext, actionId: string):
  ActionExecutorContext['presentUserApproval'] | undefined {
  const proof = (context as ChildContext)[deploymentRoleChild];
  const review = context.presentUserApproval;
  if (!proof || proof.qualifiedActionId !== actionId || proof.operation?.[deploymentRoleChild] !== true
    || !readProof(context, actionId, proof.input) || !isPresentUserHostInvocation(context)
    || context.actionCaller?.kind !== 'host' || !context.actionRequestId || !context.runtimeAccountId
    || !review || review.decidingAccountId !== context.runtimeAccountId
    || review.actionId !== proof.operation.parent.actionId
    || review.inputDigest !== computeActionInputApprovalDigestV1(review.actionId, proof.operation.parent.input)) return undefined;
  const childId = ActionIdSchema.safeParse(actionId);
  if (!childId.success) return undefined;
  return { actionId: childId.data, requestId: context.actionRequestId,
    inputDigest: computeActionInputApprovalDigestV1(childId.data, proof.input),
    decidingAccountId: review.decidingAccountId };
}

/** Keep the complete signed projection at its owner; transports never copy its keys. */
export function readHostAdmittedReviewedChildHttpProofV1(context: ActionExecutorContext | undefined): ReviewedActionChildHttpProofV1 | undefined {
  const admitted = readHostAdmittedReviewedChildV1(context);
  if (!admitted) return undefined;
  const { input: _input, ...proof } = admitted;
  return proof;
}

/** Only this issuer's exact child can retain the original ingress authority.
 * Descriptor clones do not inherit authority from either authorization object. */
export function readHostReviewedChildOriginalAuthorizationV1(context: ActionExecutorContext | undefined):
  ExternalActionExecutionAuthorizationV1 | undefined {
  const proof = (context as ChildContext | undefined)?.[deploymentRoleChild];
  if (!proof?.reviewedChild || proof.operation?.[deploymentRoleChild] !== true
    || !readProof(context, proof.qualifiedActionId, proof.input)
    || context?.externalActionExecutionAuthorization !== proof.childAuthorization) return undefined;
  return proof.originalAuthorization;
}

function createReviewedChildProof(actionId: string, role: string, input: JsonValue, rootActionId: string | undefined,
  parentAdmission?: DeploymentNativeAdmissionV1, environmentId?: string): ReviewedActionChildHttpProofV1 {
  const native = isDeploymentDomainAddActionIdV1(actionId) && 'content' in readRecord(input)
    || rootActionId === 'deployments.environments.create' && actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 && role === 'preview.backup'
    ? projectDeploymentNativeAdmissionV1(actionId, input)
    : actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 && role === 'backup.bindings'
      && isDeploymentBackupConfigureNativeAdmissionV1(parentAdmission) ? parentAdmission
    : actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 && role === DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1
      && isDeploymentTelemetryNativeAdmissionV1(parentAdmission) ? parentAdmission : undefined;
  return Object.freeze({ actionId, role,
    inputDigest: computeActionInputApprovalDigestV1(actionId as ActionId, input),
    ...(actionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 && role === DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1
      && environmentId ? { environmentId } : {}),
    ...(isDeploymentDomainNativeAdmissionV1(native) || isDeploymentBackupConfigureNativeAdmissionV1(native) || isDeploymentTelemetryNativeAdmissionV1(native)
      ? { deploymentNativeAdmission: native } : {}) });
}

function attachReviewedChildHttpProjection(context: ActionExecutorContext, childContext: ChildContext, proof: ChildProof,
  requesterCustodySource?: ActionExecutorContext): void {
  const authorization = context.externalActionExecutionAuthorization;
  const originalAuthorization = readHostReviewedChildOriginalAuthorizationV1(context)
    ?? (requesterCustodySource?.externalActionExecutionAuthorization === authorization
      ? readHostReviewedChildOriginalAuthorizationV1(requesterCustodySource) : undefined)
    ?? (authorization === proof.parentProof?.childAuthorization ? proof.parentProof?.originalAuthorization : undefined)
    ?? authorization;
  const http = originalAuthorization?.requesterHttpProjection;
  const reviewedChild = proof.reviewedChild;
  const rootActionId = proof.rootActionId;
  if (!reviewedChild || !rootActionId || !authorization || !http) return;
  const rootOperation = deploymentOperationForRootActionV1(rootActionId, authorization.binding.deploymentPreparationAdmission);
  const spendsRootOperation = rootOperation !== undefined && reviewedChild.actionId === `deployments.${rootOperation}`;
  const readsUnderBindingsChild = reviewedChild.actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
    && reviewedChild.role === DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1;
  const dataTeardownPreview = reviewedChild.role === DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1;
  const childAuthorization: ExternalActionExecutionAuthorizationV1 = { ...authorization };
  Object.defineProperties(proof, {
    originalAuthorization: { value: originalAuthorization },
    childAuthorization: { value: childAuthorization },
  });
  Object.defineProperties(childAuthorization, {
    ...Object.getOwnPropertyDescriptors(authorization),
    requesterHttpProjection: { value: Object.freeze({ ...http,
      createRequestHeaders: async (request: Parameters<typeof http.createRequestHeaders>[0]) => {
        if (!readProof(childContext, proof.qualifiedActionId, proof.input)) return null;
        // Host reads retain the admitted parent purpose; child effects carry
        // the exact operand accepted by ordinary Action admission and review.
        const { reviewedChild: _reviewedChild, ...parentRequest } = request;
        // Teardown previews open the Environment metadata and content with their existing read-only child purpose.
        if (dataTeardownPreview && request.method.toUpperCase() === 'GET' && request.body === undefined
          && /^\/v1\/(?:deployments\/environments\/[^/?#]+(?:\?[^#]*)?|artifacts\/[^/?#]+)$/u.test(request.path))
          return http.createRequestHeaders({ ...parentRequest, effectActionId: reviewedChild.actionId, reviewedChild });
        // Codec and content reads consume the same selected read operand as metadata.
        if (reviewedChild.environmentId !== undefined)
          return http.createRequestHeaders({ ...parentRequest, effectActionId: reviewedChild.actionId, reviewedChild });
        // A writer's Artifact/currentness GET prepares its effect under the
        // admitted root; the exact child mutation retains its review proof.
        // Without an invocation envelope the issuer received a core ActionId.
        // A child that is the root's own receipt operation (a Create or Template
        // spending its deploy intent) keeps its effect: Home binds the root's
        // candidate publication to that operation and its reviewed role, never to the root.
        // The telemetry bindings child reads the private runtime Link it is changing.
        if (!proof.envelope && !spendsRootOperation && !readsUnderBindingsChild && request.effectActionId === proof.qualifiedActionId
          && request.method.toUpperCase() === 'GET'
          && (await import('../actionSpecs.js')).getActionSpec(proof.qualifiedActionId as ActionId).sideEffectClass === 'write')
          return http.createRequestHeaders({ ...parentRequest, effectActionId: rootActionId });
        const credentialPurpose = request.effectActionId === rootActionId
          ? readTeamCredentialActionHttpPurposeV1(request) : null;
        const carriesChildCredential = credentialPurpose
          && credentialPurpose.consumer.operationId === originalAuthorization?.binding.requestId
          && credentialPurpose.consumer.actionId === reviewedChild.actionId
          && (credentialPurpose.kind === 'direct_material' || credentialPurpose.inputDigest === reviewedChild.inputDigest);
        return http.createRequestHeaders(request.effectActionId === rootActionId
          ? carriesChildCredential ? { ...parentRequest, reviewedChild } : parentRequest
          : proof.envelope || request.effectActionId === proof.qualifiedActionId
            ? { ...request, effectActionId: proof.qualifiedActionId, reviewedChild }
            : parentRequest);
      },
    }), enumerable: false },
  });
  Object.defineProperty(childContext, 'externalActionExecutionAuthorization', {
    value: Object.freeze(childAuthorization), enumerable: true,
  });
}

/** Called by the executor after this exact child's ordinary admission and review.
 * Public context cannot manufacture the issuer's private operand or role. */
export function retainHostReviewedChildAdmissionV1(context: ActionExecutorContext, actionId: string,
  input: unknown, admittedInput: unknown = input): ActionExecutorContext | undefined {
  const proof = readProof(context, actionId, input);
  const binding = context.externalActionExecutionAuthorization?.binding;
  if (!proof?.operation || !proof.role || binding && binding.actionId !== proof.rootActionId) return undefined;
  // Admission can stamp an Agent selection before an operation re-enters the
  // executor. Match the issuer's original operand first, then retain the exact
  // admitted operand rather than leaving its nested children with a stale proof.
  if (proof.envelope && !sameStrictJsonValue(readRecord(admittedInput).action, proof.envelope.action)) return undefined;
  const admittedProofInput = normalizeStrictJsonValue(proof.envelope ? readRecord(admittedInput).input ?? null : admittedInput);
  if (proof.operation[deploymentRoleChild] === true && sameStrictJsonValue(admittedProofInput, proof.input)) return context;
  const envelope = proof.envelope ? { ...proof.envelope, input: admittedProofInput } : undefined;
  const admittedProof: ChildProof = { ...proof,
    input: admittedProofInput,
    ...(envelope ? { envelope } : {}),
    operation: { ...proof.operation, [deploymentRoleChild]: true,
      steps: envelope ? [{ actionId: 'action.invoke', input: envelope }]
        : [{ actionId: proof.qualifiedActionId, input: admittedProofInput as Record<string, JsonValue> }] },
    ...(binding?.actionId === proof.rootActionId ? {
      reviewedChild: createReviewedChildProof(proof.qualifiedActionId, proof.role, admittedProofInput, proof.rootActionId,
        proof.parentProof?.reviewedChild?.deploymentNativeAdmission ?? binding?.deploymentNativeAdmission, proof.environmentId),
    } : {}),
  };
  const admittedContext: ChildContext = { ...context, [deploymentRoleChild]: admittedProof };
  attachReviewedChildHttpProjection(context, admittedContext, admittedProof);
  return admittedContext;
}

/** Capture this admitted child before the runner takes custody. Its callback
 * supplies the operation's own lifetime and retained root requester ports. */
export function retainHostReviewedChildOperationContextV1(context: ActionExecutorContext, actionId: string,
  input: unknown): ((operationContext: ActionExecutorContext) => ActionExecutorContext) | undefined {
  const proof = readProof(context, actionId, input);
  if (!proof) return undefined;
  const backupApply = BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply;
  const admittedBackupApply = proof[deploymentRoleChild] === true && proof.receivingAdmission
    && proof.reviewedChild?.actionId === backupApply.action && proof.reviewedChild.role === backupApply.role;
  if (proof.operation?.[deploymentRoleChild] !== true && !admittedBackupApply) return undefined;
  return operationContext => {
    const { signal: _callerSignal, ...admittedProof } = proof;
    const retainedProof: ChildProof = { ...admittedProof,
      ...(operationContext.signal ? { signal: operationContext.signal } : {}) };
    const retainedContext: ChildContext = { ...operationContext, [deploymentRoleChild]: retainedProof };
    attachReviewedChildHttpProjection(operationContext, retainedContext, retainedProof);
    return retainedContext;
  };
}

/** Restore an exact signed leaf already admitted by ingress, without inventing parent consent.
 * Only the trusted ingress adapter supplies this operand after verifying its signed binding. */
export async function invokeHostAdmittedSignedReviewedChildV1<T>(params: Readonly<{
  context: ActionExecutorContext;
  child: ReviewedActionChildHttpProofV1 & Readonly<{ input: JsonValue }>;
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
  execute(input: JsonValue, context: ActionExecutorContext): Promise<T>;
}>): Promise<T> {
  const { input, ...reviewedChild } = params.child;
  const proof: ChildProof = {
    qualifiedActionId: reviewedChild.actionId, input: normalizeStrictJsonValue(input), reviewedChild,
    [deploymentRoleChild]: true,
    ...(params.context.signal ? { signal: params.context.signal } : {}),
    ...(params.receivingAdmission ? { receivingAdmission: params.receivingAdmission } : {}),
  };
  const context: ChildContext = { ...params.context, bypassApprovals: false,
    hostReviewedChild: undefined, [deploymentRoleChild]: proof };
  return params.execute(proof.input, context);
}

/** Single in-process issuer. Domain adapters supply admitted, normalized facts. */
export async function invokeHostReviewedChildV1<T = ActionExecuteResult, TAction extends ActionId = ActionId>(params: Readonly<{
  parent: HostReviewedParentV1;
  context: ActionExecutorContext;
  child: HostReviewedChildV1<TAction>;
  /** The host context before an adapter projected fields for the next Action. Only its exact requester authorization is carried. */
  requesterCustodySource?: ActionExecutorContext;
  invocationServices?: HostReviewedChildInvocationV1['invocationServices'];
  /** Supplied only by the receiving custody/placement owner after ordinary admission. */
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
  admittedReview?: HostReviewedChildPolicyV1;
  /** The parent executor's review decision; custody admission alone is not person approval. */
  reviewAdmitted?: boolean;
  /** Live Run reader's retained person; private proof only, never accepted from Action JSON. */
  approvedBy?: WorkflowApprovedOperationV1['approvedBy'];
  environmentId?: string;
  environmentApprovalScope?: EnvironmentApprovalScope;
  execute(input: unknown, context: ActionExecutorContext, actionId: TAction | 'action.invoke'): Promise<T>;
}>): Promise<T | ActionExecuteFailure> {
  const { context } = params;
  const { child, parent } = params;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const receiving = params.receivingAdmission;
  if (context.signal?.aborted) return reviewedChildScopeDenied('aborted');
  // The domain admission owns the reviewed parent's relationship to the request.
  if (!parent.actionId || receiving && (!binding || receiving.actorAccountId !== binding.accountId
      || receiving.actorAccountId !== context.runtimeAccountId)
    || binding && binding.accountId !== context.runtimeAccountId) return reviewedChildScopeDenied('issuer_binding');
  if (binding && !sameStrictJsonValue(context.externalActionTarget, binding.target)) return reviewedChildScopeDenied('issuer_target');
  const childInput = normalizeStrictJsonValue(child.input);
  const parentInput = normalizeStrictJsonValue(parent.input);
  if (!parentInput || typeof parentInput !== 'object' || Array.isArray(parentInput)) return reviewedChildScopeDenied('child_mismatch');
  const action = typeof child.action === 'string' ? child.action : { ...child.action };
  const invocation = action === 'action.invoke'
    ? PluginContributionIdentityV1Schema.safeParse(readRecord(childInput).action) : undefined;
  if (invocation && !invocation.success) return reviewedChildScopeDenied('child_mismatch');
  const envelope: ChildProof['envelope'] = typeof action === 'string'
    ? invocation?.success ? { ...(childInput as Record<string, JsonValue>), action: invocation.data } : undefined
    : { action, input: childInput };
  if (!envelope && (!childInput || typeof childInput !== 'object' || Array.isArray(childInput))) return reviewedChildScopeDenied('child_mismatch');
  const qualifiedActionId = envelope ? formatQualifiedPluginActionId(envelope.action) : action as ActionId;
  const proofInput = envelope ? envelope.input ?? null : childInput;
  const callerProof = readProof(context, parent.actionId, parentInput);
  const parentProof = callerProof?.operation?.[deploymentRoleChild] === true
    && (!binding || binding.actionId === callerProof.rootActionId) ? callerProof : undefined;
  const admittedParent = readHostAdmittedReviewedParentV1(context.hostReviewedChild);
  const reviewAdmitted = params.reviewAdmitted ?? (params.admittedReview !== undefined || parentProof !== undefined
    || admittedParent?.actionId === parent.actionId && sameStrictJsonValue(admittedParent.input, parentInput));
  let environmentApprovalScope: EnvironmentApprovalScope | undefined;
  if (child.role === DEPLOYMENT_DATABASE_READ_ACCESS_BINDINGS_CHILD_ROLE_V1) {
    const admission = projectDeploymentReadAdmissionV1(parent.actionId, parentInput);
    // The host issues only a child its parent declares. A local parent may have no signed
    // root; Home admits the issued child on the signed root's bound plan.
    const declared = selectDeploymentReviewedChildPlanV1({ actionId: parent.actionId,
      ...(admission ? { deploymentReadAdmission: admission } : {}) });
    const setup = readDeploymentDatabaseReadAccessBindingChildV1({ ...(admission ? { deploymentReadAdmission: admission } : {}),
      ...(declared ? { deploymentReviewedChildPlan: declared } : {}) }, { actionId: qualifiedActionId, role: child.role });
    const patch = DeploymentBindingsPatchInputV1Schema.safeParse(proofInput);
    if (!reviewAdmitted || !setup || !admission || !('databaseTarget' in admission) || !patch.success
      || patch.data.serverId !== admission.databaseTarget.environment.serverId || patch.data.environmentId !== setup.environmentId
      || patch.data.set.length !== 1 || patch.data.remove.length
      || patch.data.telemetryMachineId !== undefined || patch.data.telemetry !== undefined
      || patch.data.telemetryCollector !== undefined || patch.data.providerVariables !== undefined
      || params.environmentApprovalScope && params.environmentApprovalScope.environmentId !== setup.environmentId)
      return reviewedChildScopeDenied('child_mismatch');
    environmentApprovalScope = params.environmentApprovalScope;
    const selected = patch.data.set[0];
    if (!selected || selected.purpose !== 'dataRole' || !('targetLinkId' in selected) || selected.targetLinkId !== setup.targetLinkId
      || selected.role !== 'readOnlyPassword')
      return reviewedChildScopeDenied('child_mismatch');
    const source = DeploymentSecretBindingSourceV1Schema.safeParse(selected.source);
    if (!source.success) return reviewedChildScopeDenied('child_mismatch');
    if (!setup.requiresDatabaseWriter) {
      const attach = readRecord(readRecord(parentInput).input);
      if (source.data.ref !== attach.savedSecretRef || source.data.resourceRevision !== attach.resourceRevision)
        return reviewedChildScopeDenied('child_mismatch');
    }
  }
  const rootActionId = parentProof?.rootActionId ?? parent.actionId;
  const reviewedChild = reviewAdmitted && binding?.actionId === rootActionId
    ? createReviewedChildProof(qualifiedActionId, child.role, proofInput, rootActionId,
      parentProof?.reviewedChild?.deploymentNativeAdmission ?? binding?.deploymentNativeAdmission, params.environmentId) : undefined;
  const proof: ChildProof = {
    rootActionId, role: child.role, qualifiedActionId, input: proofInput,
    ...(parentProof ? { parentProof } : {}),
    ...(reviewedChild ? { reviewedChild } : {}),
    ...(environmentApprovalScope ? { environmentApprovalScope } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(envelope ? { envelope } : {}),
    ...(params.environmentId ? { environmentId: params.environmentId } : {}),
    ...(receiving ? { receivingAdmission: structuredClone(receiving) } : {}),
    ...(params.admittedReview?.[credentialScopeAdmission] ? {
      [credentialScopeAdmission]: params.admittedReview[credentialScopeAdmission],
    } : {}),
    operation: {
      ...(params.approvedBy ? { approvedBy: structuredClone(params.approvedBy), approvedRequestId: context.actionRequestId ?? undefined } : {}),
      ...(reviewAdmitted ? { [deploymentRoleChild]: true as const } : {}),
      parent: { actionId: parent.actionId, input: parentInput as Record<string, JsonValue> },
      // Contributed operands can be any JSON value. Keep their single ordinary
      // Action envelope, not a scalar cast into the stored Workflow record shape.
      steps: envelope ? [{ actionId: 'action.invoke', input: envelope }]
        : [{ actionId: qualifiedActionId, input: childInput as Record<string, JsonValue> }],
    },
  };
  const childContext: ChildContext = { ...context, bypassApprovals: false,
    hostReviewedChild: undefined, invocationServices: params.invocationServices, [deploymentRoleChild]: proof };
  // Independently Home-bound Run children keep their own incumbent ceiling.
  attachReviewedChildHttpProjection(context, childContext, proof, params.requesterCustodySource);
  return await params.execute(envelope ?? childInput, childContext, typeof child.action === 'string' ? child.action : 'action.invoke');
}

/** One host port; domain owners supply concrete child input after their ordinary admission. */
export function createHostReviewedChildPortV1(params: Readonly<{
  actionId: string; input: unknown; context: ActionExecutorContext;
  plan?: HostReviewedChildrenPlanV1;
  policies?: readonly HostReviewedChildPolicyV1[];
  /** Diagnostic facts from the policy owner; never admit the refused child. */
  refusedPolicy?: HostReviewedChildPolicyV1 & Readonly<{ requiredActionIds: readonly string[] }>;
  reviewAdmitted?: true;
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
  /** Parent-only review ports have no prepared child execution. */
  execute?: (input: unknown, context: ActionExecutorContext, actionId: ActionId) => Promise<ActionExecuteResult>;
}>): HostReviewedChildPortV1 {
  const plan = params.plan;
  const parent = { actionId: params.actionId, input: projectNativeJsonValueForTransport(params.input) as Record<string, JsonValue> };
  const parentInput = readRecord(parent.input);
  const environmentId = ((params.context.externalActionExecutionAuthorization
    ? params.context.externalActionExecutionAuthorization.binding.deploymentChildRoot === true
    : isDeploymentChildEffectActionIdV1(params.actionId)) || params.actionId === 'deployments.teardown'
    || params.actionId === 'deployments.cancel' || params.actionId === 'deployments.receipts.observe'
    || params.actionId === 'deployments.logs.read') && typeof parentInput.environmentId === 'string' ? parentInput.environmentId : undefined;
  const port: ReviewedChildPort = {
    ...(params.reviewAdmitted ? { parent, [deploymentRoleChild]: true as const,
      ...(plan ? { [reviewedChildPlan]: { plan, ...(params.policies ? { policies: params.policies } : {}) } } : {}) } : {}),
    ...(plan ? { preparedChildren: plan.children.flatMap(child => child.input === undefined ? []
      : [{ action: child.action, role: child.role, input: child.input }]) } : {}),
    invoke: async request => {
      const execute = params.execute;
      if (!plan || !execute) return reviewedChildScopeDenied('no_plan', params.refusedPolicy
        ? { ...params.refusedPolicy, requestedSurface: params.context.surface } : undefined);
      const matches = plan.children.flatMap((child, index) => child.role === request.role
        && sameStrictJsonValue(child.action, request.action)
        && (child.input === undefined || sameStrictJsonValue(child.input, request.input))
        && (child.scopeInput === undefined || Object.entries(child.scopeInput)
          .every(([key, value]) => sameStrictJsonValue(readRecord(request.input)[key], value))) ? [index] : []);
      if (matches.length !== 1) return reviewedChildScopeDenied('child_mismatch');
      return invokeHostReviewedChildV1({ parent, context: params.context,
        child: { action: request.action, role: request.role, input: request.input },
        ...(request.invocationServices ? { invocationServices: request.invocationServices } : {}),
        ...(params.receivingAdmission ? { receivingAdmission: params.receivingAdmission } : {}),
        ...(environmentId ? { environmentId } : {}),
        admittedReview: params.policies?.[matches[0]!],
        execute: (input, context, actionId) => execute(input, { ...context, hostReviewedChild: port }, actionId) });
    },
  };
  return port;
}

/** Host-private Backup receiver Setup Apply child admitted by the receiving Machine for its exact reviewed root. */
export function readHostAdmittedBackupReceiverSetupApplyV1(params: Readonly<{
  context: ActionExecutorContext | undefined;
  actionId: string;
  input: unknown;
}>): Readonly<{
  requesterAccountId: string;
  binding: ExternalActionExecutionAuthorizationV1['binding'];
  child: NonNullable<ReturnType<typeof readHostAdmittedReviewedChildV1>>;
  receiving: SocketRpcMachineAdmissionContextV1;
}> | null {
  const { context, actionId, input } = params;
  const setup = BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply;
  if (!context || actionId !== setup.action) return null;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const requesterAccountId = binding ? readAuthenticatedActionRequesterAccountIdV1(binding) : null;
  if (!binding || !requesterAccountId
    || readExternalActionBindingAuthority(binding) !== 'present_user'
    || context.authority !== 'present_user'
    || (context.surface !== 'ui' && context.surface !== 'cli' && context.surface !== 'voice')
    || context.sessionInputSource || context.causalPermissionAuthority != null || context.rpcSessionAuthorization
    || (context.actionCaller !== undefined && context.actionCaller.kind !== 'host')
    || (context.runtimeAccountId !== undefined && context.runtimeAccountId !== requesterAccountId)
    || binding.requestId !== context.actionRequestId
    || binding.sessionActionOrigin || binding.workflowActionOrigin) {
    return null;
  }
  const child = readHostAdmittedReviewedChildV1(context);
  const receiving = child ? readHostReviewedChildReceivingAdmissionV1(context) : null;
  const nativeAdmission = binding.deploymentNativeAdmission;
  if (!child || !receiving
    || child.actionId !== setup.action || child.role !== setup.role
    || !sameStrictJsonValue(child.input, input)
    || !isDeploymentBackupConfigureNativeAdmissionV1(nativeAdmission)
    || nativeAdmission.receiverInstallationId !== receiving.installationId
    || typeof binding.environmentId !== 'string' || binding.environmentId.length === 0
    || child.environmentId !== binding.environmentId
    || nativeAdmission.environmentId !== binding.environmentId
    || receiving.role !== 'manage' || receiving.actorAccountId !== requesterAccountId
    || !isBackupReceiverSetupChildOperandV1({
      binding,
      reviewedChild: child,
      machineId: receiving.machineId,
      params: input,
    })
    || deriveBackupReceiverSetupRunIdV1(binding, child) === null) {
    return null;
  }
  return { requesterAccountId, binding, child, receiving };
}
