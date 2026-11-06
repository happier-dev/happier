export { bindScmRefineSavedSessionV1, verifyScmRefineSavedSessionV1, isScmRefineInputPurposeV1,
  isScmRefineInputRpcPurposeV1 } from './executor/scmRefineInputPurpose.js';
import { z } from 'zod/mini';
import { ManagedCredentialInstallInputV1Schema } from '../machines/managed/credentialDeliveryV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER, ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { MachineSetupPlanInputV1Schema, type MachineSetupPlanInputV1 } from '../machines/managed/actionsV1.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
import { WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceExecutionV1 } from '../rpc/socket.js';
import { DeploymentChildExecutionProofV1Schema, type DeploymentChildExecutionProofV1 } from '../deployments/deploymentChildExecutionProofV1.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { computeCanonicalDomainSeparatedDigest, encodeCanonicalLengthDelimited } from '../crypto/canonicalDigest.js';
import { ActionResolvedSessionTargetsV1Schema, type ActionResolvedSessionTargetsV1 } from './sessionTargetV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { MachineInstallationPrivateKeySchema, MachineInstallationPublicKeySchema } from '../machines/identity/installationIdentity.js';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSeedRoutingV1Schema,
  type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1, type WorkspaceSyncSeedRoutingV1 } from '../rpc/socket.js';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 } from '../sessions/messages/sessionPendingMachineAdmissionV1.js';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 } from '../sessions/messages/sessionPendingExecutionRunMachineAdmissionV2.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { SessionRequesterInstallationSealedBootstrapV1Schema } from '../sessions/creation/sessionRequesterBootstrapSchemasV1.js';
import type { ApprovalRequesterConfirmationV1 } from '../approvals/approvalRequestV1.js';

export type ExternalActionMachineRpcEventV1 = typeof SOCKET_RPC_EVENTS.CALL
  | typeof SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
  | typeof SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2;
import { ExternalActionRequestEnvelopeSchema, ExternalActionRequestIdV1Schema, ExternalActionTargetV1Schema,
  ReviewedActionChildHttpProofV1Schema, type ReviewedActionChildHttpProofV1,
  projectExternalActionDeploymentNativeEnvelopeAdmissionV1, isDeploymentDomainNativeAdmissionV1,
  type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionExecutionAuthorizationV1,
  type ExternalActionTargetV1, type ExternalActionRequestEnvelope } from './externalActionApi.js';

export const TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 = 'x-happier-template-birth-authorization';

/** The original requester spends a finite template root without impersonating its Machine. */
export function createTemplateRequesterExecutionHttpHeadersV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  requesterToken: string;
  effectActionId: string;
  target: ExternalActionTargetV1;
  reviewedChild?: ReviewedActionChildHttpProofV1;
}>): Readonly<Record<string, string>> | null {
  if (input.authorization.binding.actionId !== 'template.instantiate'
    && input.authorization.binding.actionId !== 'template.updates.apply') return null;
  return {
    Authorization: `Bearer ${input.requesterToken}`,
    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorization.token,
    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: input.effectActionId,
    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(input.target),
    ...(input.reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(input.reviewedChild) } : {}),
  };
}

export function encodeTemplateBirthExecutionAuthorizationV1(authorization: ExternalActionExecutionAuthorizationV1): string {
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(
    ExternalActionExecutionAuthorizationV1Schema.parse(authorization))), 'base64url');
}

export function decodeTemplateBirthExecutionAuthorizationV1(value: string): ExternalActionExecutionAuthorizationV1 | null {
  try {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value, 'base64url'))));
    return encodeTemplateBirthExecutionAuthorizationV1(authorization) === value ? authorization : null;
  } catch { return null; }
}

/** Private input is consumed only after the issuer's signed setup admission was verified. */
export function readTemplateRequesterSetupPlanInputV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  originalActionEnvelope: ExternalActionRequestEnvelope;
  input: unknown;
}>): MachineSetupPlanInputV1 | null {
  const binding = input.authorization.binding;
  const plan = MachineSetupPlanInputV1Schema.safeParse(input.input);
  if (!plan.success || binding.actionId !== 'template.instantiate' || binding.admittedMachineRole !== 'manage'
    || !binding.templateRequesterSetupAdmission?.planInputDigest
    || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId,
      machineId: binding.machineId, envelope: input.originalActionEnvelope })
    || plan.data.homeId !== binding.serverIdentityId || plan.data.machineId !== binding.machineId
    || plan.data.mode !== 'effects'
    || computeActionInputApprovalDigestV1('machines.setup.plan', plan.data) !== binding.templateRequesterSetupAdmission.planInputDigest) return null;
  return plan.data;
}

export function computeExternalActionRequestEnvelopeDigestV1(envelope: ExternalActionRequestEnvelope): string {
  return computeCanonicalDomainSeparatedDigest('happier-external-action-envelope-v1', [
    createCanonicalJsonSigningInput(ExternalActionRequestEnvelopeSchema.parse(envelope)),
  ]);
}

/** Exact envelope binding only; current principal and installation admission remain Home-owned. */
export function isExternalActionAuthorizationBoundToEnvelope(binding: ExternalActionExecutionAuthorizationBindingV1,
  input: Readonly<{ actionId: string; machineId: string; envelope: ExternalActionRequestEnvelope }>): boolean {
  try {
    const nativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1(input);
  return binding.actionId === input.actionId && binding.machineId === input.machineId
    && binding.requestId === input.envelope.requestId
    && binding.idempotencyKey === input.envelope.idempotencyKey
    && (input.envelope.v !== 2 || binding.machineRuntimeDemand === input.envelope.machineRuntimeDemand)
    && (input.envelope.target?.kind === 'session'
      || input.envelope.target?.kind === 'machine' && input.envelope.target.machineId === input.machineId)
    && encodeExternalActionResolvedTargetV1(binding.target) === encodeExternalActionResolvedTargetV1(input.envelope.target)
    && binding.requestEnvelopeDigest === computeExternalActionRequestEnvelopeDigestV1(input.envelope)
    && (binding.actionId === 'deployments.environments.update' && nativeAdmission !== undefined
        || isDeploymentDomainNativeAdmissionV1(nativeAdmission) || nativeAdmission !== undefined && 'kind' in nativeAdmission && (nativeAdmission.kind === 'restart' || nativeAdmission.kind === 'restore')
      ? binding.environmentId === nativeAdmission.environmentId && sameStrictJsonValue(binding.deploymentNativeAdmission, nativeAdmission)
      : (binding.actionId === 'action.operations.get' || binding.actionId === 'deployments.teardown'
        ? binding.environmentId : binding.deploymentCandidatePublication?.environmentId) === nativeAdmission?.environmentId);
  } catch { return false; }
}

/** Binds the real Session RPC carrier without reinterpreting its ciphertext as an Action envelope. */
export function computeExternalActionSocketRpcRequestDigestV1(request: Readonly<{
  method: string;
  requestId: string;
  params?: unknown;
  target: Extract<ExternalActionTargetV1, { kind: 'session' }>;
}>): string {
  const target = ExternalActionTargetV1Schema.parse(request.target);
  if (target.kind !== 'session') throw new TypeError('Session input RPC authorization requires a Session target');
  return computeCanonicalDomainSeparatedDigest('happier-external-action-session-rpc-v1', [
    request.method, ExternalActionRequestIdV1Schema.parse(request.requestId),
    createCanonicalJsonSigningInput(target),
    request.params === undefined ? 'absent' : 'json',
    createCanonicalJsonSigningInput(request.params === undefined ? null : request.params),
  ]);
}

export function encodeExternalActionResolvedTargetV1(target: ExternalActionTargetV1): string {
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(target))), 'base64url');
}

export function decodeExternalActionResolvedTargetV1(value: string): ExternalActionTargetV1 | null {
  try {
    const target = ExternalActionTargetV1Schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value, 'base64url'))));
    return encodeExternalActionResolvedTargetV1(target) === value ? target : null;
  } catch { return null; }
}

export function encodeReviewedActionChildHttpProofV1(value: ReviewedActionChildHttpProofV1): string {
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(
    ReviewedActionChildHttpProofV1Schema.parse(value))), 'base64url');
}

export function decodeReviewedActionChildHttpProofV1(value: string): ReviewedActionChildHttpProofV1 | null {
  try {
    const proof = ReviewedActionChildHttpProofV1Schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(decodeBase64(value, 'base64url'))));
    return encodeReviewedActionChildHttpProofV1(proof) === value ? proof : null;
  } catch { return null; }
}

type MachineRequest = Readonly<{
  authorizationToken: string;
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  requestId: string;
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  reviewedChild?: ReviewedActionChildHttpProofV1;
}>;

function machineRequestBytes(request: MachineRequest): Uint8Array {
  return encodeCanonicalLengthDelimited([
    'happier-external-action-machine-request-v1', request.authorizationToken, request.effectActionId,
    request.installationId, request.requestId,
    createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(request.target)),
    request.method.toUpperCase(), request.path,
    request.body === undefined ? 'absent' : 'json',
    createCanonicalJsonSigningInput(request.body === undefined ? null : request.body),
    ...(request.idempotencyKey === undefined ? [] : ['idempotency-key', request.idempotencyKey]),
    ...(request.reviewedChild === undefined ? [] : ['reviewed-action-child-http-v1',
      encodeReviewedActionChildHttpProofV1(request.reviewedChild)]),
  ]);
}

type ApprovalInput = Readonly<{ authorizationToken: string; actionId: string; target: ExternalActionTargetV1; input: unknown;
  requesterConfirmation?: ApprovalRequesterConfirmationV1; sessionTargetsV1?: ActionResolvedSessionTargetsV1 }>;
type MachineRpcRequest = Readonly<{
  authorizationToken: string;
  /** Exact incumbent private custody, authenticated by the installed producer. */
  requesterAccountContext?: ExternalActionExecutionAuthorizationV1['requesterAccountContext'];
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  /** The transport owner supplies its finite carrier; omission retains the released CALL bytes. */
  event?: string;
  method: string;
  requestId: string;
  params?: unknown;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  managedAdmission?: Readonly<{ actionId: 'machines.managed.credentials.install'; input: z.infer<typeof ManagedCredentialInstallInputV1Schema> }>;
  reviewedChild?: ReviewedActionChildHttpProofV1;
}>;

/** One finite spawn descendant; the Home and installed host still prove its exact accepted binding. */
export function readSessionSpawnNativeCredentialChildV1(input: Readonly<{
  rootActionId: string; effectActionId: string; method: string; managedAdmission?: unknown; params?: unknown;
}>) {
  if (input.rootActionId !== 'session.spawn_new' || input.effectActionId !== 'machines.managed.credentials.install'
    || input.method !== 'machines.managed.credentials.install') return null;
  const admission = z.strictObject({ actionId: z.literal('machines.managed.credentials.install'),
    input: ManagedCredentialInstallInputV1Schema }).safeParse(input.managedAdmission);
  if (!admission.success || admission.data.input.operation === 'release' || admission.data.input.executionRunId) return null;
  if (input.params !== undefined && typeof input.params !== 'string'
    && !sameStrictJsonValue(input.params, admission.data.input)) return null;
  return admission.data.input;
}

function machineRpcRequestBytes(request: MachineRpcRequest): Uint8Array {
  const event = request.event ?? SOCKET_RPC_EVENTS.CALL;
  if (event !== SOCKET_RPC_EVENTS.CALL && event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
    && event !== SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2) {
    throw new TypeError('Unsupported external Action Machine carrier');
  }
  if (request.workspaceSyncSeedRouting !== undefined && (event !== SOCKET_RPC_EVENTS.CALL
    || request.effectActionId !== 'projects.open' || !request.method.endsWith(`:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`)
    || request.workspaceSyncSourceRouting !== undefined || request.workspaceSyncSourceWriterTargetRouting !== undefined)) {
    throw new TypeError('Seed routing requires the exact Project export preparation carrier');
  }
  return encodeCanonicalLengthDelimited([
    'happier-external-action-machine-rpc-v1', request.authorizationToken,
    request.effectActionId, request.installationId,
    event,
    createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(request.target)),
    request.method, request.requestId,
    request.params === undefined ? 'absent' : 'json',
    computeCanonicalDomainSeparatedDigest('happier-external-action-rpc-payload-v1', [
      createCanonicalJsonSigningInput(request.params === undefined ? null : request.params),
    ]),
    ...(request.requesterAccountContext !== undefined ? [
      'requester-account-context-v1',
      createCanonicalJsonSigningInput(SessionRequesterInstallationSealedBootstrapV1Schema.parse(request.requesterAccountContext)),
    ] : []),
    ...(request.workspaceSyncSourceWriterTargetRouting !== undefined ? [
      'workspace-sync-source-writer-target-v1',
      createCanonicalJsonSigningInput(WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(request.workspaceSyncSourceWriterTargetRouting)),
    ] : []),
    ...(request.workspaceSyncSourceRouting !== undefined ? [
      'workspace-sync-source-routing-v1',
      createCanonicalJsonSigningInput(WorkspaceSyncSourceRoutingV1Schema.parse(request.workspaceSyncSourceRouting)),
    ] : []),
    ...(request.workspaceSyncSeedRouting !== undefined ? [
      'workspace-sync-seed-routing-v1',
      createCanonicalJsonSigningInput(WorkspaceSyncSeedRoutingV1Schema.parse(request.workspaceSyncSeedRouting)),
    ] : []),
    ...(request.reviewedChild === undefined ? [] : ['reviewed-action-child-rpc-v1',
      encodeReviewedActionChildHttpProofV1(request.reviewedChild)]),
    ...(request.managedAdmission !== undefined ? ['managed-native-credential-child-v1',
      createCanonicalJsonSigningInput(z.strictObject({ actionId: z.literal('machines.managed.credentials.install'),
        input: ManagedCredentialInstallInputV1Schema }).parse(request.managedAdmission))] : []),

  ]);
}

export function signExternalActionMachineRpcRequestV1(input: MachineRpcRequest & Readonly<{ privateKey: string | Uint8Array }>): string {
  const privateKey = typeof input.privateKey === 'string'
    ? decodeBase64(MachineInstallationPrivateKeySchema.parse(input.privateKey), 'base64url') : input.privateKey;
  return encodeBase64(signEd25519Message(machineRpcRequestBytes(input), privateKey), 'base64url');
}

export function verifyExternalActionMachineRpcRequestV1(input: MachineRpcRequest & Readonly<{ publicKey: string | Uint8Array; signature: string }>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    return verifyEd25519Signature(machineRpcRequestBytes(input), signature, publicKey);
  } catch { return false; }
}

function approvalInputBytes(input: ApprovalInput): Uint8Array {
  return encodeCanonicalLengthDelimited([
    'happier-external-action-approval-input-v1', input.authorizationToken,
    input.actionId, createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(input.target)),
    createCanonicalJsonSigningInput(input.input),
    ...(input.requesterConfirmation ? ['requester-confirmation-v1', createCanonicalJsonSigningInput(input.requesterConfirmation)] : []),
    ...(input.sessionTargetsV1 ? ['session-targets-v1', createCanonicalJsonSigningInput(ActionResolvedSessionTargetsV1Schema.parse(input.sessionTargetsV1))] : []),
  ]);
}

export function signExternalActionApprovalInputV1(input: ApprovalInput & Readonly<{ privateKey: string | Uint8Array }>): string {
  const privateKey = typeof input.privateKey === 'string'
    ? decodeBase64(MachineInstallationPrivateKeySchema.parse(input.privateKey), 'base64url') : input.privateKey;
  return encodeBase64(signEd25519Message(approvalInputBytes(input), privateKey), 'base64url');
}

export function verifyExternalActionApprovalInputV1(input: ApprovalInput & Readonly<{ publicKey: string | Uint8Array; signature: string }>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    return verifyEd25519Signature(approvalInputBytes(input), signature, publicKey);
  } catch { return false; }
}

/** Uses the existing installation key; the Home authorization is never sufficient alone. */
export function signExternalActionMachineRequestV1(input: MachineRequest & Readonly<{ privateKey: string | Uint8Array }>): string {
  const privateKey = typeof input.privateKey === 'string'
    ? decodeBase64(MachineInstallationPrivateKeySchema.parse(input.privateKey), 'base64url') : input.privateKey;
  return encodeBase64(signEd25519Message(machineRequestBytes(input), privateKey), 'base64url');
}

export function verifyExternalActionMachineRequestV1(input: MachineRequest & Readonly<{ publicKey: string | Uint8Array; signature: string }>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    return verifyEd25519Signature(machineRequestBytes(input), signature, publicKey);
  } catch { return false; }
}

export type { DeploymentChildExecutionProofV1 } from '../deployments/deploymentChildExecutionProofV1.js';

export function computeExternalActionMachineRpcParamsDigestV1(params: unknown): string {
  return computeCanonicalDomainSeparatedDigest('happier-external-action-rpc-payload-v1', [
    createCanonicalJsonSigningInput(params === undefined ? null : params),
  ]);
}

export function createDeploymentChildExecutionProofV1(value: WorkspaceSyncSourceExecutionV1,
  archiveOrigin?: DeploymentChildExecutionProofV1['archiveOrigin'],
  nativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource']): DeploymentChildExecutionProofV1 {
  return DeploymentChildExecutionProofV1Schema.parse({ ...projectDeploymentChildExecutionProofV1(value),
    ...(archiveOrigin ? { archiveOrigin } : {}), ...(nativeIncumbentSource ? { nativeIncumbentSource } : {}) });
}

export function projectDeploymentChildExecutionProofV1(value: WorkspaceSyncSourceExecutionV1): DeploymentChildExecutionProofV1 {
  const packet = WorkspaceSyncSourceExecutionV1Schema.parse(value);
  if (!packet.externalActionExecution.deploymentChildRouting || !packet.originalActionEnvelope) {
    throw new TypeError('Deployment HTTP custody requires its exact original child packet');
  }
  return DeploymentChildExecutionProofV1Schema.parse({ method: packet.method, requestId: packet.requestId,
    paramsPresent: packet.params !== undefined, paramsDigest: computeExternalActionMachineRpcParamsDigestV1(packet.params),
    externalActionExecution: packet.externalActionExecution });
}
