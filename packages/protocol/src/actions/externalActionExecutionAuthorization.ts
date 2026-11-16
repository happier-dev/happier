import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { isWorkspaceSyncRelationshipWriteActionId } from './actionIds.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
export { bindScmRefineSavedSessionV1, verifyScmRefineSavedSessionV1, isScmRefineInputPurposeV1,
  isScmRefineInputRpcPurposeV1 } from './executor/scmRefineInputPurpose.js';
import { computeCanonicalDomainSeparatedDigest, encodeCanonicalLengthDelimited } from '../crypto/canonicalDigest.js';
import { ActionResolvedSessionTargetsV1Schema, type ActionResolvedSessionTargetsV1 } from './sessionTargetV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { MachineInstallationPrivateKeySchema, MachineInstallationPublicKeySchema } from '../machines/identity/installationIdentity.js';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSeedRoutingV1Schema,
  WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceExecutionV1,
  type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1, type WorkspaceSyncSeedRoutingV1 } from '../rpc/socket.js';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 } from '../sessions/messages/sessionPendingMachineAdmissionV1.js';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 } from '../sessions/messages/sessionPendingExecutionRunMachineAdmissionV2.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { SessionRequesterInstallationSealedBootstrapV1Schema } from '../sessions/creation/sessionRequesterBootstrapSchemasV1.js';
import { DeploymentChildRoutingV1Schema, type DeploymentChildRoutingV1 } from '../deployments/deploymentChildRoutingV1.js';
import { DeploymentChildExecutionProofV1Schema, type DeploymentChildExecutionProofV1 } from '../deployments/deploymentChildExecutionProofV1.js';
import { readDeploymentArchiveRpcEffectV1 } from '../deployments/deploymentArchiveRpcV1.js';
export type { DeploymentChildExecutionProofV1 } from '../deployments/deploymentChildExecutionProofV1.js';
import type { ApprovalRequesterConfirmationV1 } from '../approvals/approvalRequestV1.js';
import { ManagedCredentialInstallInputV1Schema } from '../machines/managed/credentialDeliveryV1.js';
import { projectWorkspaceSyncAdmissionInputV1, deriveWorkspaceSyncRelationshipId } from '../workspaces/workspaceSyncAdmissionV1.js';

export type ExternalActionMachineRpcEventV1 = typeof SOCKET_RPC_EVENTS.CALL
  | typeof SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
  | typeof SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2;
import { ExternalActionRequestEnvelopeSchema, ExternalActionRequestIdV1Schema, ExternalActionTargetV1Schema,
  ReviewedActionChildHttpProofV1Schema, type ReviewedActionChildHttpProofV1,
  projectExternalActionDeploymentReadEnvelopeAdmissionV1, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
  projectExternalActionPresetPreparationEnvelopeAdmissionV1,
  projectExternalActionDeploymentNativeEnvelopeAdmissionV1,
  projectExternalActionDeploymentLinkEnvelopeEnvironmentIdV1,
  projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1,
  isDeploymentDomainNativeAdmissionV1, isDeploymentDomainDnsNativeAdmissionV1,
  projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1,
  projectExternalActionDiscussionEnvelopeIdV1,
  ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionExecutionAuthorizationV1,
  type ExternalActionTargetV1, type ExternalActionRequestEnvelope } from './externalActionApi.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { readExternalActionBindingAuthority } from './externalActionBindingAuthority.js';
export { readExternalActionBindingAuthority } from './externalActionBindingAuthority.js';
export type { ExternalActionBindingAuthorityProjectionV1 } from './externalActionBindingAuthority.js';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER } from './externalActionApi.js';

/** HTTP framing only: signatures and admission still bind the original request body. */
export const EXTERNAL_ACTION_HTTP_BODY_HEADER_V1 = 'x-happier-action-body';
/** POST transport of a signed logical GET; the V1 proof frame is unchanged. */
export const EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 = 'get-v1';
const externalActionHttpAuthorizationHeaders = {
  executionAuthorization: EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  machineSignature: EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  effectActionId: EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  target: EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  deploymentChild: EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER,
  reviewedChild: EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
} as const;
export const EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1: readonly string[] = Object.values(externalActionHttpAuthorizationHeaders);
const ExternalActionHttpBodyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  authorization: z.strictObject({
    executionAuthorization: z.string().check(z.minLength(1)),
    machineSignature: z.string().check(z.minLength(1)),
    effectActionId: z.string().check(z.minLength(1)),
    target: z.string().check(z.minLength(1)),
    deploymentChild: z.optional(z.string().check(z.minLength(1))),
    reviewedChild: z.optional(z.string().check(z.minLength(1))),
  }),
  body: z.optional(z.unknown()),
}));

export type ExternalActionHttpBodyV1 = z.infer<typeof ExternalActionHttpBodyV1Schema>;

/** Signed requests carry potentially large root/child proofs in JSON, never in HTTP headers. */
export function encodeExternalActionHttpBodyV1(headers: Readonly<Record<string, unknown>>, body: unknown): ExternalActionHttpBodyV1 | null {
  const authorization = Object.fromEntries(Object.entries(externalActionHttpAuthorizationHeaders)
    .flatMap(([field, header]) => headers[header] === undefined ? [] : [[field, headers[header]]]));
  const frame = ExternalActionHttpBodyV1Schema.safeParse({ v: 1, authorization,
    ...(body === undefined ? {} : { body }) });
  return frame.success ? frame.data : null;
}

/** Restore only the closed proof vocabulary before route validation and authentication. */
export function decodeExternalActionHttpBodyV1(value: unknown): Readonly<{
  headers: Readonly<Record<string, string>>; body: unknown | undefined;
}> | null {
  const frame = ExternalActionHttpBodyV1Schema.safeParse(value);
  if (!frame.success) return null;
  const headers: Record<string, string> = {};
  for (const [field, header] of Object.entries(externalActionHttpAuthorizationHeaders)) {
    const proof = frame.data.authorization[field as keyof typeof externalActionHttpAuthorizationHeaders];
    if (proof !== undefined) headers[header] = proof;
  }
  return { headers, body: frame.data.body };
}


export function computeExternalActionRequestEnvelopeDigestV1(envelope: ExternalActionRequestEnvelope): string {
  return computeCanonicalDomainSeparatedDigest('happier-external-action-envelope-v1', [
    createCanonicalJsonSigningInput(ExternalActionRequestEnvelopeSchema.parse(envelope)),
  ]);
}

/** Exact envelope and closed-purpose binding; current resource authority remains Home-owned. */
export function isExternalActionAuthorizationBoundToEnvelope(binding: ExternalActionExecutionAuthorizationBindingV1,
  input: Readonly<{ actionId: string; machineId: string; envelope: ExternalActionRequestEnvelope }>): boolean {
  try {
    const nativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1(input);
    const metadataEnvironmentId = projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1(input);
    const sync = input.envelope.v === 1 ? projectWorkspaceSyncAdmissionInputV1(input.actionId, input.envelope.input)
      : input.envelope.workspaceSyncAdmission;
    const boundSync = binding.workspaceSyncAdmission;
    if (sync ? !boundSync || boundSync.source.machineId !== sync.sourceMachineId
      || boundSync.sourceWorkspaceRefId !== sync.sourceWorkspaceRefId
      || boundSync.relationshipId !== (sync.relationshipId ?? deriveWorkspaceSyncRelationshipId(binding.requestId))
      : boundSync !== undefined) return false;
    return binding.actionId === input.actionId && binding.machineId === input.machineId
      && binding.requestId === input.envelope.requestId
      && binding.idempotencyKey === input.envelope.idempotencyKey
      && (input.envelope.v !== 2 || binding.machineRuntimeDemand === input.envelope.machineRuntimeDemand)
      && (input.envelope.target?.kind === 'session'
        || input.envelope.target?.kind === 'machine' && input.envelope.target.machineId === input.machineId)
      && encodeExternalActionResolvedTargetV1(binding.target) === encodeExternalActionResolvedTargetV1(input.envelope.target)
      && binding.requestEnvelopeDigest === computeExternalActionRequestEnvelopeDigestV1(input.envelope)
      && binding.discussionId === projectExternalActionDiscussionEnvelopeIdV1(input)
      && (metadataEnvironmentId === undefined || binding.environmentId === metadataEnvironmentId)
      && sameStrictJsonValue(binding.deploymentReadAdmission, projectExternalActionDeploymentReadEnvelopeAdmissionV1(input))
      && sameStrictJsonValue(binding.deploymentPreparationAdmission, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1(input))
      && sameStrictJsonValue(binding.presetPreparationAdmission, projectExternalActionPresetPreparationEnvelopeAdmissionV1(input))
      && (binding.deploymentLinkAdmission === undefined
        || binding.deploymentLinkAdmission.environmentId === projectExternalActionDeploymentLinkEnvelopeEnvironmentIdV1(input))
      && (binding.actionId === 'deployments.environments.update' && nativeAdmission !== undefined
        || isDeploymentDomainNativeAdmissionV1(nativeAdmission) || isDeploymentDomainDnsNativeAdmissionV1(nativeAdmission) || nativeAdmission !== undefined && 'kind' in nativeAdmission && (nativeAdmission.kind === 'restart' || nativeAdmission.kind === 'restore' || nativeAdmission.kind === 'backup' || nativeAdmission.kind === 'backupConfigure' || nativeAdmission.kind === 'promote')
        ? binding.environmentId === nativeAdmission.environmentId && sameStrictJsonValue(binding.deploymentNativeAdmission, nativeAdmission)
        : (binding.actionId === 'action.operations.get' || binding.actionId === 'deployments.teardown'
          ? binding.environmentId : binding.deploymentCandidatePublication?.environmentId) === nativeAdmission?.environmentId)
      && sameStrictJsonValue(binding.registryAppUpdateAdmission, projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1(input));
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

/** One digest owner for actual RPC bytes; a caller-supplied digest is never a signer input. */
export function computeExternalActionMachineRpcParamsDigestV1(params: unknown): string {
  return computeCanonicalDomainSeparatedDigest('happier-external-action-rpc-payload-v1', [
    createCanonicalJsonSigningInput(params === undefined ? null : params),
  ]);
}

/** Drop bulky ciphertext, retaining the exact digest already authenticated by the source signature. */
export function projectDeploymentChildExecutionProofV1(value: WorkspaceSyncSourceExecutionV1): DeploymentChildExecutionProofV1 {
  const packet = WorkspaceSyncSourceExecutionV1Schema.parse(value);
  if (!packet.externalActionExecution.deploymentChildRouting || !packet.originalActionEnvelope) {
    throw new TypeError('Deployment HTTP custody requires its exact original child packet');
  }
  return DeploymentChildExecutionProofV1Schema.parse({ method: packet.method, requestId: packet.requestId,
    paramsPresent: packet.params !== undefined, paramsDigest: computeExternalActionMachineRpcParamsDigestV1(packet.params),
    externalActionExecution: packet.externalActionExecution });
}

/** Only the receiver adds this value-free claim; Home must prove its immutable lineage. */
export function createDeploymentChildExecutionProofV1(value: WorkspaceSyncSourceExecutionV1,
  archiveOrigin?: DeploymentChildExecutionProofV1['archiveOrigin'],
  nativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource']): DeploymentChildExecutionProofV1 {
  return DeploymentChildExecutionProofV1Schema.parse({ ...projectDeploymentChildExecutionProofV1(value),
    ...(archiveOrigin ? { archiveOrigin } : {}), ...(nativeIncumbentSource ? { nativeIncumbentSource } : {}) });
}

function encodeDeploymentChildExecutionProofV1(proof: DeploymentChildExecutionProofV1): string {
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(DeploymentChildExecutionProofV1Schema.parse(proof))), 'base64url');
}

// HTTP already carries this token once. Keep the binding and all private optional
// fields intact; only the transport replaces the duplicate token with a reference.
const DeploymentChildHttpProofV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentChildExecutionProofV1Schema.shape,
  externalActionExecution: z.strictObject({
    ...DeploymentChildExecutionProofV1Schema.shape.externalActionExecution.shape,
    authorization: z.strictObject({
      ...ExternalActionExecutionAuthorizationV1Schema.shape,
      token: z.strictObject({ ref: z.literal('http-authorization') }),
    }),
  }),
}));

function encodeDeploymentChildHttpProofV1(proof: DeploymentChildExecutionProofV1): string {
  const execution = proof.externalActionExecution;
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(DeploymentChildHttpProofV1Schema.parse({
    ...proof, externalActionExecution: { ...execution,
      authorization: { ...execution.authorization, token: { ref: 'http-authorization' } } },
  }))), 'base64url');
}

/** HTTP transport references its outer token; signatures retain the full logical proof. */
export function encodeDeploymentChildExecutionV1(value: WorkspaceSyncSourceExecutionV1,
  archiveOrigin?: DeploymentChildExecutionProofV1['archiveOrigin'],
  nativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource']): string {
  return encodeDeploymentChildHttpProofV1(createDeploymentChildExecutionProofV1(value, archiveOrigin, nativeIncumbentSource));
}

export function decodeDeploymentChildExecutionV1(value: string, authorizationToken?: string): DeploymentChildExecutionProofV1 | null {
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value, 'base64url')));
    const reference = DeploymentChildHttpProofV1Schema.safeParse(decoded);
    if (reference.success) {
      if (!authorizationToken) return null;
      const execution = reference.data.externalActionExecution;
      const proof = DeploymentChildExecutionProofV1Schema.parse({ ...reference.data,
        externalActionExecution: { ...execution, authorization: { ...execution.authorization, token: authorizationToken } } });
      return encodeDeploymentChildHttpProofV1(proof) === value ? proof : null;
    }
    const proof = DeploymentChildExecutionProofV1Schema.parse(decoded);
    return encodeDeploymentChildExecutionProofV1(proof) === value ? proof : null;
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
  deploymentChildExecution?: WorkspaceSyncSourceExecutionV1;
  deploymentArchiveOrigin?: DeploymentChildExecutionProofV1['archiveOrigin'];
  deploymentNativeIncumbentSource?: DeploymentChildExecutionProofV1['nativeIncumbentSource'];
}>;

function machineRequestBytes(request: MachineRequest, proof?: DeploymentChildExecutionProofV1): Uint8Array {
  if (request.deploymentNativeIncumbentSource && (!request.deploymentChildExecution && !proof
    || proof?.nativeIncumbentSource && createCanonicalJsonSigningInput(request.deploymentNativeIncumbentSource)
      !== createCanonicalJsonSigningInput(proof.nativeIncumbentSource))) {
    throw new TypeError('Native source custody requires its exact receiver-signed proof');
  }
  if (request.deploymentArchiveOrigin && !request.deploymentChildExecution && !proof
    || request.deploymentArchiveOrigin && proof?.archiveOrigin
      && createCanonicalJsonSigningInput(request.deploymentArchiveOrigin) !== createCanonicalJsonSigningInput(proof.archiveOrigin)) {
    throw new TypeError('Archive origin requires its one exact receiver-signed parent proof');
  }
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
    ...(request.deploymentChildExecution === undefined && proof === undefined ? [] : ['deployment-child-execution-v1',
      proof ? encodeDeploymentChildExecutionProofV1({ ...proof,
        ...(request.deploymentArchiveOrigin ? { archiveOrigin: request.deploymentArchiveOrigin } : {}),
        ...(request.deploymentNativeIncumbentSource ? { nativeIncumbentSource: request.deploymentNativeIncumbentSource } : {}) })
        : encodeDeploymentChildExecutionProofV1(createDeploymentChildExecutionProofV1(request.deploymentChildExecution!,
          request.deploymentArchiveOrigin, request.deploymentNativeIncumbentSource))]),
  ]);
}

type ApprovalInput = Readonly<{ authorizationToken: string; actionId: string; target: ExternalActionTargetV1; input: unknown;
  requesterConfirmation?: ApprovalRequesterConfirmationV1; sessionTargetsV1?: ActionResolvedSessionTargetsV1 }>;
type MachineRpcRequest = Readonly<{
  authorizationToken: string;
  reviewedChild?: ReviewedActionChildHttpProofV1;
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
  deploymentChildRouting?: DeploymentChildRoutingV1;
  managedAdmission?: Readonly<{ actionId: 'machines.managed.credentials.install'; input: z.infer<typeof ManagedCredentialInstallInputV1Schema> }>;
  /** Actual retained source packet only. The signer derives its compact proof. */
  deploymentChildExecution?: WorkspaceSyncSourceExecutionV1;
  deploymentArchiveOrigin?: DeploymentChildExecutionProofV1['archiveOrigin'];
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

function machineRpcRequestBytes(request: MachineRpcRequest, payloadProof?: Readonly<{ paramsPresent: boolean; paramsDigest: string }>,
  sourceProof?: DeploymentChildExecutionProofV1): Uint8Array {
  const event = request.event ?? SOCKET_RPC_EVENTS.CALL;
  if (event !== SOCKET_RPC_EVENTS.CALL && event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
    && event !== SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2) {
    throw new TypeError('Unsupported external Action Machine carrier');
  }
  if (request.workspaceSyncSeedRouting !== undefined && (event !== SOCKET_RPC_EVENTS.CALL
    || request.effectActionId !== 'projects.open' && !isWorkspaceSyncRelationshipWriteActionId(request.effectActionId)
    || !request.method.endsWith(`:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`)
    || request.workspaceSyncSourceRouting !== undefined || request.workspaceSyncSourceWriterTargetRouting !== undefined)) {
    throw new TypeError('Seed routing requires the exact admitted workspace export preparation carrier');
  }
  if (request.deploymentChildRouting !== undefined && (event !== SOCKET_RPC_EVENTS.CALL
    || request.effectActionId !== request.deploymentChildRouting.actionId
    || request.method !== `${request.deploymentChildRouting.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`)) {
    throw new TypeError('Deployment routing requires its exact finite child carrier');
  }
  if (request.deploymentArchiveOrigin && sourceProof?.archiveOrigin
    && createCanonicalJsonSigningInput(request.deploymentArchiveOrigin) !== createCanonicalJsonSigningInput(sourceProof.archiveOrigin)) {
    throw new TypeError('Archive origin must match its retained receiver annotation');
  }
  const controllerProof = sourceProof ? DeploymentChildExecutionProofV1Schema.parse({ ...sourceProof,
    ...(request.deploymentArchiveOrigin ? { archiveOrigin: request.deploymentArchiveOrigin } : {}) }) : (request.deploymentChildExecution
    ? createDeploymentChildExecutionProofV1(request.deploymentChildExecution, request.deploymentArchiveOrigin) : undefined);
  if (request.deploymentArchiveOrigin && !controllerProof) throw new TypeError('Archive origin requires its exact parent proof');
  if (controllerProof) {
    const routing = controllerProof.externalActionExecution.deploymentChildRouting;
    if (event !== SOCKET_RPC_EVENTS.CALL || !routing || routing.kind === 'dataRole' || routing.kind === 'review' || routing.kind === 'prepare'
      || routing.kind === 'member' && routing.phase === 'cleanup'
      || readDeploymentArchiveRpcEffectV1(request.method.slice(request.method.indexOf(':') + 1)) !== request.effectActionId
      || request.installationId !== routing.installationId
      || request.authorizationToken !== controllerProof.externalActionExecution.authorization.token
      || encodeExternalActionResolvedTargetV1(request.target) !== encodeExternalActionResolvedTargetV1(controllerProof.externalActionExecution.target)
      || request.deploymentChildRouting !== undefined) throw new TypeError('Archive phases require their exact admitted receiver proof');
  }
  return encodeCanonicalLengthDelimited([
    'happier-external-action-machine-rpc-v1', request.authorizationToken,
    request.effectActionId, request.installationId,
    event,
    createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(request.target)),
    request.method, request.requestId,
    payloadProof ? payloadProof.paramsPresent ? 'json' : 'absent' : request.params === undefined ? 'absent' : 'json',
    payloadProof ? z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)).parse(payloadProof.paramsDigest)
      : computeExternalActionMachineRpcParamsDigestV1(request.params),
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
    ...(request.deploymentChildRouting !== undefined ? [
      'deployment-child-routing-v1',
      createCanonicalJsonSigningInput(DeploymentChildRoutingV1Schema.parse(request.deploymentChildRouting)),
    ] : []),
    ...(request.reviewedChild === undefined ? [] : ['reviewed-action-child-rpc-v1',
      encodeReviewedActionChildHttpProofV1(request.reviewedChild)]),
    ...(request.managedAdmission !== undefined ? ['managed-native-credential-child-v1',
      createCanonicalJsonSigningInput(z.strictObject({ actionId: z.literal('machines.managed.credentials.install'),
        input: ManagedCredentialInstallInputV1Schema }).parse(request.managedAdmission))] : []),
    ...(controllerProof === undefined ? [] : ['deployment-child-execution-v1', encodeDeploymentChildExecutionProofV1(controllerProof)]),
  ]);
}

export function signExternalActionMachineRpcRequestV1(input: MachineRpcRequest & Readonly<{ privateKey: string | Uint8Array }>): string {
  const privateKey = typeof input.privateKey === 'string'
    ? decodeBase64(MachineInstallationPrivateKeySchema.parse(input.privateKey), 'base64url') : input.privateKey;
  return encodeBase64(signEd25519Message(machineRpcRequestBytes(input), privateKey), 'base64url');
}

export function verifyExternalActionMachineRpcRequestV1(input: Omit<MachineRpcRequest, 'deploymentChildExecution'> & Readonly<{
  publicKey: string | Uint8Array; signature: string;
  /** Verification-only projection from an existing signed source packet. */
  paramsPresent?: boolean; paramsDigest?: string;
  deploymentChildExecution?: WorkspaceSyncSourceExecutionV1 | DeploymentChildExecutionProofV1;
}>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    if ((input.paramsDigest === undefined) !== (input.paramsPresent === undefined)
      || input.paramsDigest !== undefined && input.params !== undefined) return false;
    const child = input.deploymentChildExecution;
    const proof = child && 'paramsDigest' in child ? DeploymentChildExecutionProofV1Schema.parse(child) : undefined;
    return verifyEd25519Signature(machineRpcRequestBytes({ ...input,
      deploymentChildExecution: child && !('paramsDigest' in child) ? child : undefined }, input.paramsDigest !== undefined
      && input.paramsPresent !== undefined ? { paramsDigest: input.paramsDigest, paramsPresent: input.paramsPresent } : undefined, proof), signature, publicKey);
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

export function verifyExternalActionMachineRequestV1(input: Omit<MachineRequest, 'deploymentChildExecution'> & Readonly<{
  publicKey: string | Uint8Array; signature: string;
  deploymentChildExecution?: WorkspaceSyncSourceExecutionV1 | DeploymentChildExecutionProofV1;
}>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    const child = input.deploymentChildExecution;
    const proof = child && 'paramsDigest' in child ? DeploymentChildExecutionProofV1Schema.parse(child) : undefined;
    return verifyEd25519Signature(machineRequestBytes({ ...input,
      deploymentChildExecution: child && !('paramsDigest' in child) ? child : undefined }, proof), signature, publicKey);
  } catch { return false; }
}
