import * as zMini from '../zodRuntimePolicy.js';
import type { ManagedPluginWebhookOriginV1 } from '../plugins/webhooks/managedRepositoryWebhookRpcV1.js';
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '../auth/authToken.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionActionRpcOriginV1Schema, WorkspaceSyncSourceContextV1Schema, WorkspaceSyncTargetRoutingV1Schema, type SessionActionRpcOriginV1, type WorkspaceSyncTargetRoutingV1 } from './socketWorkspaceSyncRoutingV1.js';
export { SessionActionRpcOriginV1Schema, WorkspaceSyncSourceContextV1Schema, WorkspaceSyncTargetRoutingV1Schema, type SessionActionRpcOriginV1, type WorkspaceSyncSourceContextV1, type WorkspaceSyncTargetRoutingV1 } from './socketWorkspaceSyncRoutingV1.js';
import { SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1, SocketRpcRequestIdSchema } from './socketTransport.js';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from './socketSessionAuthorization.js';
export {
  SOCKET_RPC_EVENTS,
  SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
  SocketRpcCancellationPayloadSchema,
  SocketRpcRequestIdSchema,
  SocketRpcTransportAcknowledgementV1Schema,
  SocketRpcTransportResponseEnvelopeV1Schema,
  projectSocketRpcTargetAcknowledgementV1,
  type SocketRpcEvent,
  type SocketRpcCancellationPayload,
  type SocketRpcTransportAcknowledgementV1,
  type SocketRpcTransportResponseEnvelopeV1,
} from './socketTransport.js';
export {
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
  API_TOKEN_SOCKET_EVENT_ACTIONS,
  isSocketRpcSessionAuthorizationNamespace,
  resolveSocketRpcProviderStartingMethod,
  resolveSocketRpcSameAccountSessionAuthorizationV1,
  resolveSocketRpcSessionAuthorization,
  resolveSocketRpcSessionPermissionDecisionAuthorizationMethod,
  resolveSocketRpcSessionWriteAuthorization,
  resolveSocketRpcSessionWriteAuthorizationMethod,
  type SocketRpcAuthorizationContextKind,
  type SocketRpcSessionWriteAuthorityV1,
  type SocketRpcSessionWriteClassificationV1,
} from './socketSessionAuthorization.js';
import { IrohEndpointDescriptorV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { SignedDirectRouteGrantV2Schema, PeerRouteEphemeralPublicKeyV2Schema } from '../machines/peer/mediation/directRouteGrantV2.js';
import {
  SessionPermissionDecisionActorV1Schema,
  type SessionPermissionDecisionActorV1,
} from '../sessions/permissions/v1.js';
import { SocketRpcSessionBrowserAuthorizationContextSchema, type SocketRpcSessionBrowserAuthorizationContext } from '../sessions/access/sessionBrowserAccessV1.js';
export { SocketRpcSessionBrowserAuthorizationContextSchema, isSocketRpcSessionBrowserAuthorizationContext, type SocketRpcSessionBrowserAuthorizationContext } from '../sessions/access/sessionBrowserAccessV1.js';
import { SESSION_HANDOFF_ACTION_ID_V1 } from '../actions/actionIds.js';
import type { SessionFollowSourceKeyPrepareAuthorizationV1 } from '../sessions/follow/sessionFollowSourceKeyPreparationV1.js';
import { z } from '../zodRuntimePolicy.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { type ActionRequiredAuthority } from '../actions/metadata.js';
import { type CallerInputConstraintsV1 } from '../auth/callerInputConstraintsV1.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from './methods.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AgentStartSessionCallerV1Schema } from '../account/settings/admitAgentStartV1.js';
import { isRoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { isSessionStopChildV1 } from '../actions/sessionSectionArchive.js';

import type { ExternalActionMachineRpcExecutionV1, ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope } from '../actions/externalActionApi.js';
import { ExternalActionMachineRpcExecutionV1Schema, ExternalActionRequestEnvelopeSchema } from '../actions/externalActionApi.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { SocketRpcMachineAdmissionContextV1Schema, type SocketRpcMachineAdmissionContextV1 } from '../machines/machineAccessV1.js';
export { SocketRpcMachineAdmissionContextV1Schema, type SocketRpcMachineAdmissionContextV1,
  StructuredMessageActionRoutingV1Schema, type StructuredMessageActionRoutingV1 } from '../machines/machineAccessV1.js';

import { PROJECT_FINITE_ACTION_RPC_METHODS_V1, isProjectWorkspaceSyncOpenActionV1 } from '../actions/projectActionIdsV1.js';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '../actions/operations/methodsV1.js';
import { readDeploymentArchiveRpcEffectV1 } from '../deployments/deploymentArchiveRpcV1.js';
import { MachineSetupPlanInputV1Schema, readMachineSetupPlanChildInputV1 } from '../machines/managed/actionsV1.js';
import { isBackupReceiverSetupChildOperandV1, readReviewedMachineRpcChildFamilyV1 } from '../machines/peer/mediation/rpc/reviewedChildFamilyV1.js';
import { isSessionProjectFilesSourceOpenChildInputV1, isSessionProjectFilesSourceOpenChildRecipientOperandV1 } from '../sessions/creation/sessionProjectFilesOpenV1.js';

/** Shared retained-root transport grammar, not signature or operand admission.
 * The Home and receiving host still verify the signed root and derived child.
 * A relay may see ciphertext; opened setup and Stop operands use their owners.
 */
export function readOriginalActionEnvelopeMachineRpcKindV1(input: Readonly<{
  method: string;
  machineId: string;
  execution?: ExternalActionMachineRpcExecutionV1;
  envelope: ExternalActionRequestEnvelope;
  params: unknown;
}>): 'root' | 'child' | null {
  const { method, machineId, execution, envelope, params } = input;
  if (!execution) return null;
  const binding = execution.authorization.binding;
  const root = binding.actionId;
  const effect = execution.effectActionId;
  const exactMachineRoot = root === effect && binding.machineId === machineId
    && execution.target.kind === 'machine' && execution.target.machineId === machineId;
  if (isProjectWorkspaceSyncOpenActionV1(root)) return exactMachineRoot && method === RPC_METHODS.PROJECTS_OPEN ? 'root' : null;
  if (Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, root)) {
    return exactMachineRoot && method === PROJECT_FINITE_ACTION_RPC_METHODS_V1[root as keyof typeof PROJECT_FINITE_ACTION_RPC_METHODS_V1] ? 'root' : null;
  }
  // The cross-Machine child owner decides the family; this grammar keeps only
  // the operand facts a relay can read before the Home verifier runs.
  switch (readReviewedMachineRpcChildFamilyV1({ binding, effectActionId: effect, method,
    target: { machineId, installationId: execution.installationId }, reviewedChild: execution.reviewedChild })) {
    case 'setup_plan': {
      if (typeof params === 'string') return 'child';
      const plan = MachineSetupPlanInputV1Schema.safeParse(params);
      return plan.success && plan.data.machineId === machineId && plan.data.homeId === binding.serverIdentityId
        && (envelope.v === 2 || readMachineSetupPlanChildInputV1({ rootActionId: root,
          rootInput: envelope.input, machineId, input: params }) !== null) ? 'child' : null;
    }
    case 'backup_receiver_setup':
      return typeof params === 'string' || isBackupReceiverSetupChildOperandV1({ binding,
        reviewedChild: execution.reviewedChild, machineId, params }) ? 'child' : null;
    case 'stop':
      return isSessionStopChildV1({ rootActionId: root, effectActionId: effect, method,
        target: execution.target, params, ...(envelope.v === 1 ? { rootInput: envelope.input } : {}) }) ? 'child' : null;
    case 'deployment': {
      const child = execution.deploymentChildRouting;
      return child?.machineId === machineId && child.actionId === effect ? 'child' : null;
    }
    case 'session_project_files_source':
      return typeof params === 'string'
        || (envelope.v === 1
          ? isSessionProjectFilesSourceOpenChildInputV1({
            rootInput: envelope.input, reviewedChild: execution.reviewedChild, machineId, params,
          })
          : isSessionProjectFilesSourceOpenChildRecipientOperandV1({
            reviewedChild: execution.reviewedChild, machineId, params,
          })) ? 'child' : null;
    case 'readiness': case 'creation': case 'service_move': case 'project_setup_set': return 'child';
    case null: break;
  }
  if (root === 'action.operations.cancel') return exactMachineRoot && method === ACTION_OPERATION_RPC_METHODS_V1.cancel ? 'root' : null;
  return execution.deploymentChildExecution !== undefined && readDeploymentArchiveRpcEffectV1(method) === effect ? 'child' : null;
}

/** A legacy relay reads only the enclosing registration's first method. */
export const SocketRpcRegistrationBatchOfferV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  remainingMethods: z.array(z.string()),
}));

export const SocketRpcRegistrationBatchReceiptV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  registered: z.array(z.string()),
  rejected: z.array(z.strictObject({
    type: z.literal('register'),
    method: z.optional(z.string()),
    error: z.string(),
    retryable: z.boolean(),
  })),
}));
export type SocketRpcRegistrationBatchReceiptV1 = z.infer<typeof SocketRpcRegistrationBatchReceiptV1Schema>;

/** An omitted deadline uses the relay default; null belongs to caller lifecycle. */
export const SocketRpcTimeoutMsSchema = lazyZodSchema(() => z.optional(z.nullable(z.number().check(z.positive()))));

export {
  SocketRpcAnsweringClientV1Schema, SocketRpcAnsweringClientCandidateV1Schema,
  SocketRpcAnsweringClientCandidatesV1Schema,
  type SocketRpcAnsweringClientV1, type SocketRpcAnsweringClientCandidateV1,
} from './answeringClient.js';
import type { SocketRpcAnsweringClientV1 } from './answeringClient.js';
// A distinct operation name prevents older relays from ignoring routing input
// and delivering a mutation to an arbitrary client. It uses the same handler.
export const ANSWERING_CLIENT_RPC_PREFIX_V1 = 'answering-client.v1/';

/** The first compressed response corridor contains large, source-backed reads. */
const COMPRESSIBLE_SOCKET_RPC_RESPONSES_V1: ReadonlySet<string> = new Set([
  RPC_METHODS.SCM_STATUS_SNAPSHOT,
  RPC_METHODS.SCM_DIFF_COMMIT,
  RPC_METHODS.SCM_LOG_LIST,
  RPC_METHODS.SCM_FILE_READ,
]);

export function supportsSocketRpcResponseContentV1(method: string): boolean {
  return COMPRESSIBLE_SOCKET_RPC_RESPONSES_V1.has(method);
}

/** Relay address only. The active call and its captured codec decide the receiver. */
export const SocketRpcContinuationReturnV1Schema = lazyZodSchema(() => z.strictObject({
  socketId: z.string().check(z.minLength(1)), requestId: SocketRpcRequestIdSchema,
  proof: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
}));
export type SocketRpcContinuationReturnV1 = z.infer<typeof SocketRpcContinuationReturnV1Schema>;
export const SocketRpcContinuationFrameV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: SocketRpcRequestIdSchema, params: z.unknown(),
  callId: z.string().check(z.regex(/^[0-9a-f]{32}$/u)), reply: z.optional(z.literal(true)), notification: z.optional(z.literal(true)),
  returnTo: z.optional(SocketRpcContinuationReturnV1Schema),
}));
export const SocketRpcContinuationDeliveryV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ requestId: SocketRpcRequestIdSchema, selectedSocketId: z.string().check(z.minLength(1)) }),
  z.strictObject({ requestId: SocketRpcRequestIdSchema, senderSocketId: z.string().check(z.minLength(1)), params: z.unknown(),
    callId: z.string().check(z.regex(/^[0-9a-f]{32}$/u)), reply: z.optional(z.literal(true)), notification: z.optional(z.literal(true)) }),
]));

/** Original host-admitted Action facts, distinct from relay request correlation. Every object is closed. */
export const SocketRpcSessionActionAuthorizationContextSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session.action'),
  sessionId: AgentStartSessionCallerV1Schema.shape.sessionId,
  origin: SessionActionRpcOriginV1Schema,
}));
export type SocketRpcSessionActionAuthorizationContext = Readonly<z.infer<typeof SocketRpcSessionActionAuthorizationContextSchema>>;

/** Session-routed Actions and exact Home-admitted private workspace phases retain Session origin. */
export function isSessionActionRpcMethodV1(method: string): boolean {
  const unscoped = method.slice(method.lastIndexOf(':') + 1);
  return (unscoped.startsWith('session.') && isRoleActionIdV1(unscoped))
    || unscoped === 'skills.read'
    || unscoped === SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE
    || unscoped === RPC_METHODS.SESSION_USER_ACTION_ANSWER
    || unscoped === SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY
    || unscoped === SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET
    || unscoped === SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY_OBSERVE_V1
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE;
}

/** Non-secret routing metadata; file names, bytes and handles remain in the Session payload. */
export const SessionTransferRpcMethodV1Schema = lazyZodSchema(() => z.enum([
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
  ]));
export const SessionTransferRoutingV1Schema = lazyZodSchema(() => z.strictObject({
  method: SessionTransferRpcMethodV1Schema,
  t: z.enum(['session_attachment_upload_v1', 'session_attachment_download_v1']),
  sessionId: asProtocolZod(SessionIdSchema),
}).check(z.refine(value => ([RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT] as readonly string[]).includes(value.method)
  ? value.t === 'session_attachment_upload_v1'
  : value.t !== 'session_attachment_upload_v1')));

export type SessionTransferRoutingV1 = Readonly<z.infer<typeof SessionTransferRoutingV1Schema>>;

export const WorkspaceSyncSourceRoutingV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  phase: z.enum(['prepare', 'finalize', 'commit', 'abort']),
  operationId: z.string().check(z.trim(), z.minLength(1)),
  accountServerId: z.string().check(z.trim(), z.minLength(1)),
  sourceMachineId: z.string().check(z.trim(), z.minLength(1)),
  sourceRootPath: z.string().check(z.trim(), z.minLength(1)),
  sourceSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sourceContext: z.optional(WorkspaceSyncSourceContextV1Schema),
  originalActionEnvelope: z.optional(z.lazy(() => ExternalActionRequestEnvelopeSchema)),
}));
export type WorkspaceSyncSourceRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncSourceRoutingV1Schema>>;

/** Original installed target packet, retained beside routing rather than inside its signed snapshot. */
export const WorkspaceSyncSourceExecutionV1Schema = lazyZodSchema(() => z.strictObject({
  method: z.string().check(z.minLength(1)),
  requestId: SocketRpcRequestIdSchema,
  params: zMini.optional(StrictJsonValueSchema),
  externalActionExecution: z.lazy(() => ExternalActionMachineRpcExecutionV1Schema),
  /** Reviewed composite children retain the SOURCE packet and exact original envelope. */
  originalActionEnvelope: z.optional(z.lazy(() => ExternalActionRequestEnvelopeSchema)),
}).check(z.refine(value => {
  if (!value.originalActionEnvelope) return true;
  const execution = value.externalActionExecution;
  const method = value.method.slice(value.method.indexOf(':') + 1);
  const machineId = value.method.slice(0, value.method.indexOf(':'));
  // Only a cross-Machine reviewed child carries its original envelope; the owner names the family.
  switch (readReviewedMachineRpcChildFamilyV1({ binding: execution.authorization.binding, effectActionId: execution.effectActionId,
    method, target: { machineId, installationId: execution.installationId }, reviewedChild: execution.reviewedChild })) {
    case null: return false;
    case 'deployment': return execution.deploymentChildRouting?.machineId === machineId
      && execution.deploymentChildRouting.actionId === execution.effectActionId;
    case 'stop': return isSessionStopChildV1({ rootActionId: execution.authorization.binding.actionId,
      effectActionId: execution.effectActionId, method, target: execution.target, params: value.params,
      ...(value.originalActionEnvelope.v === 1 ? { rootInput: value.originalActionEnvelope.input } : {}) });
    default: return true;
  }
})));
export type WorkspaceSyncSourceExecutionV1 = Readonly<z.infer<typeof WorkspaceSyncSourceExecutionV1Schema>>;

// Keep method reads lazy: socket and method exports can participate in source-load cycles.
function workspaceSyncTargetMethodsV1() {
  return {
    preflight: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
    prepare: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
    release: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
    inspect: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT,
    dependencies: RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES,
    remove: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE,
  } satisfies Readonly<Record<WorkspaceSyncTargetRoutingV1['phase'], string>>;
}

export function readWorkspaceSyncTargetMethodV1(phase: WorkspaceSyncTargetRoutingV1['phase']): string {
  return workspaceSyncTargetMethodsV1()[phase];
}

export function isWorkspaceSyncTargetReadMethodV1(method: string): boolean {
  return method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE
    || method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ;
}

/** Installed writers can inspect the exact retained Sync endpoint as well as a Worker copy. */
export function isWorkspaceSyncSourceWriterTargetMethodV1(
  phase: WorkspaceSyncTargetRoutingV1['phase'], method: string, machineId?: string,
): boolean {
  const prefix = machineId === undefined ? '' : `${machineId}:`;
  return method === `${prefix}${readWorkspaceSyncTargetMethodV1(phase)}`
    || phase === 'inspect' && method.startsWith(prefix) && isWorkspaceSyncTargetReadMethodV1(method.slice(prefix.length));
}

export function isWorkspaceSyncTargetMethodV1(method: string): boolean {
  return Object.values(workspaceSyncTargetMethodsV1()).some(value => value === method);
}

/** Installed SOURCE cleanup reaches retained TARGET custody without a new Action root. */
export function isWorkspaceSyncSourceWriterCleanupPhaseV1(phase: WorkspaceSyncTargetRoutingV1['phase']): boolean {
  return phase === 'release' || phase === 'inspect' || phase === 'dependencies' || phase === 'remove';
}

/** Signed `session.handoff` release routing uses Home's release admission instead of ambient custodian cleanup. */
export function isSignedWorkspaceSyncHandoffReleaseV1(
  routing: Pick<WorkspaceSyncTargetRoutingV1, 'phase'> | Readonly<{ target: Pick<WorkspaceSyncTargetRoutingV1, 'phase'> }> | null | undefined,
  authorization: ExternalActionExecutionAuthorizationV1 | null | undefined,
): boolean {
  const phase = routing ? ('target' in routing ? routing.target.phase : routing.phase) : undefined;
  return phase === 'release' && authorization?.binding.actionId === SESSION_HANDOFF_ACTION_ID_V1;
}

/** The installed physical source writer retains the original child root for exact target custody phases. */
export const WorkspaceSyncSourceWriterTargetRoutingV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  source: z.extend(WorkspaceSyncSourceRoutingV1Schema, { sourceContext: WorkspaceSyncSourceContextV1Schema }),
  target: z.omit(WorkspaceSyncTargetRoutingV1Schema, { targetContext: true }),
  sourceWriter: zMini.pick(SocketRpcMachineAdmissionContextV1Schema, { machineId: true, installationId: true }),
}).check(z.superRefine((routing, ctx) => {
  if (routing.source.accountServerId !== routing.target.accountServerId) {
    ctx.addIssue({ code: 'custom', path: ['target', 'accountServerId'], message: 'Workspace phases must retain the same Home' });
  }
  if (routing.source.sourceMachineId !== routing.source.sourceContext.machineAdmission.machineId) {
    ctx.addIssue({ code: 'custom', path: ['source', 'sourceContext', 'machineAdmission', 'machineId'], message: 'Source context must retain its original child' });
  }
})));
export type WorkspaceSyncSourceWriterTargetRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncSourceWriterTargetRoutingV1Schema>>;

/** Installed P2 may request only the seed of its already admitted Target prepare. */
export const WorkspaceSyncSeedRoutingV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sourceWriterTarget: WorkspaceSyncSourceWriterTargetRoutingV1Schema,
  target: WorkspaceSyncTargetRoutingV1Schema,
  carrierPublicKey: z.optional(PeerRouteEphemeralPublicKeyV2Schema),
}).check(z.superRefine((routing, ctx) => {
  const sourceContext = routing.sourceWriterTarget.source.sourceContext;
  const { targetContext, ...phase } = routing.target;
  if (routing.target.phase !== 'prepare' || routing.sourceWriterTarget.target.phase !== 'prepare'
    || createCanonicalJsonSigningInput(phase) !== createCanonicalJsonSigningInput(routing.sourceWriterTarget.target)) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'Seed must retain the exact Target prepare snapshot' });
  }
  if (targetContext.machineAdmission.machineId !== routing.target.targetMachineId
    || targetContext.machineAdmission.actorAccountId !== sourceContext.machineAdmission.actorAccountId
    || createCanonicalJsonSigningInput({ ...targetContext, machineAdmission: sourceContext.machineAdmission })
      !== createCanonicalJsonSigningInput(sourceContext)) {
    ctx.addIssue({ code: 'custom', path: ['target', 'targetContext'], message: 'Seed must retain the original actor and ceilings' });
  }
})));
export type WorkspaceSyncSeedRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncSeedRoutingV1Schema>>;

export const WorkspaceSyncSeedCarrierV1Schema = lazyZodSchema(() => z.strictObject({
  endpoint: IrohEndpointDescriptorV1Schema,
  grant: SignedDirectRouteGrantV2Schema,
}));
export type WorkspaceSyncSeedCarrierV1 = Readonly<z.infer<typeof WorkspaceSyncSeedCarrierV1Schema>>;

export type SocketRpcRequestPayload = Readonly<{
  method: string;
  answeringClient?: SocketRpcAnsweringClientV1;
  /** Verified relay stamps only; receiver defaults missing authority to automation. */
  callerAuthority?: ActionRequiredAuthority;
  /** Home-validated source Machine stamp; never accepted from an inbound header. */
  sessionActionOrigin?: SessionActionRpcOriginV1;
  callerInputConstraints?: CallerInputConstraintsV1;
  /** Server-issued invocation proof; the relay never forwards caller-authored material here. */
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Exact Project envelope bound by the verified Home Root; not an authority by itself. */
  originalActionEnvelope?: ExternalActionRequestEnvelope;
  transferRouting?: SessionTransferRoutingV1;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  /** Content-free selectors; Home authorizes them and stamps the exact projection in machineAdmission. */
  structuredMessageRouting?: import('../machines/machineAccessV1.js').StructuredMessageActionRoutingV1;
  params: unknown;
  /**
   * Ephemeral transport correlation. Issuers use it to cancel their own
   * in-flight relay; the authenticated relay replaces it before target dispatch.
   */
  requestId?: string;
  /** Home stamp for admitted own-Machine Project Open observation, independent of cancellation. */
  projectOpenRequestId?: string;
  /** Opt-in finite bidirectional exchange during this call; never operation authority. */
  continuation?: true;
  /** Authenticated relay stamp; inbound caller fields are never forwarded here. */
  continuationReturn?: SocketRpcContinuationReturnV1;
  /** Payload-free diagnostics only; never grants cancellation or execution custody. */
  traceId?: string;
  /** Caller offers this decoder for one response. The Home forwards only a recognized version. */
  responseContentVersion?: 1;
  /** Cooperative cancel requests stop work but retain this call's own result ACK. */
  waitForResultOnCancel?: boolean;
  authorization?: SocketRpcAuthorizationContext;
  /** Current Home admission for the exact Machine receiver, distinct from Session authority. */
  machineAdmission?: SocketRpcMachineAdmissionContextV1;
  /** Home-admitted physical receiver; routed child authority remains in machineAdmission. */
  receivingMachineAdmission?: SocketRpcMachineAdmissionContextV1;
  externalActionExecution?: ExternalActionMachineRpcExecutionV1;
  /** Omission uses the relay default; null delegates expiry to caller lifecycle. */
  timeoutMs?: number | null;
  transportResponseEnvelopeVersion?: typeof SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1;
}>;

/** Browser Session operations consume the Session owner's existing capabilities. */
export function resolveSessionBrowserRpcCapabilityV1(method: string): 'readTranscript' | 'submitAgentInput' | null {
  switch (method) {
    case RPC_METHODS.DAEMON_BROWSER_VIEW_LIST:
    case RPC_METHODS.DAEMON_BROWSER_VIEW_WATCH:
    case RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT:
    case RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START:
      return 'readTranscript';
    case RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH:
      return 'submitAgentInput';
    default:
      return null;
  }
}

export type SocketRpcSessionReadAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_READ;
  sessionId: string;
}>;

export const SocketRpcSessionWriteAuthorizationContextSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE),
  sessionId: z.string().check(z.minLength(1)),
  /** Server-proven owner classification for an operation that requires this fact. Never caller-authored. */
  authority: z.optional(z.literal('sessionOwner')),
}));
export type SocketRpcSessionWriteAuthorizationContext = Readonly<z.infer<typeof SocketRpcSessionWriteAuthorizationContextSchema>>;

/**
 * Account identity proven by the authenticated server after resolving a
 * permission decision's session owner/share grant. It is intentionally not a
 * client-supplied input or a general caller identity carrier.
 */
export type SocketRpcSessionPermissionRespondAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND;
  sessionId: string;
  actor: Extract<SessionPermissionDecisionActorV1, Readonly<{ kind: 'accountUser' }>>;
  /** Only requester Action decisions carry the verified credential's existing facts. */
  authentication?: SessionPermissionDecisionAuthenticationV1;
}>;

export const SessionPermissionDecisionAuthenticationV1Schema = lazyZodSchema(() => z.strictObject({
  tokenEpoch: z.number().check(z.int(), z.nonnegative()),
  evidence: z.optional(AuthTokenAuthenticationEvidenceSnapshotV1Schema),
}));
export type SessionPermissionDecisionAuthenticationV1 = z.infer<typeof SessionPermissionDecisionAuthenticationV1Schema>;

/**
 * A server-only transport origin for the one Automation reply-handoff daemon
 * dispatch. Generic client `CALL` rejects that method before forwarding, so a
 * caller-supplied marker never reaches the daemon as this authority.
 */
export type SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN;
}>;

/**
 * A server-only transport origin for the one reserved Session start dispatch.
 * Generic client `CALL` rejects the method before forwarding, so a
 * caller-supplied marker never becomes this authority at the daemon.
 */
export type SocketRpcSessionServerStartServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_SERVER_START_SERVER_ORIGIN;
}>;

/**
 * A server-only transport origin for the reserved external Action dispatch.
 * Generic client `CALL` rejects that method before forwarding, so a
 * caller-supplied marker never becomes Action API authority at the daemon.
 */
export type SocketRpcActionApiServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.ACTION_API_SERVER_ORIGIN;
}>;

/** Exact internal access-loss delivery from the Home to its current custodian installation. */
export type SocketRpcMachineAccessLossServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.MACHINE_ACCESS_LOSS_SERVER_ORIGIN;
}>;
export const MACHINE_ACCESS_LOSS_SERVER_ORIGIN: SocketRpcMachineAccessLossServerOriginAuthorizationContext = Object.freeze({
  kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
});

/** Home-only admission for one selected service on its current custodian installation. */
export type SocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN;
}>;
export const LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN: SocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext = Object.freeze({
  kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN,
});

/** Home-owned reads also used by encrypted clients; this stamp is never client-call authority. */
export const SocketRpcMachineReadServerOriginAuthorizationContextV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.MACHINE_READ_SERVER_ORIGIN),
  accountId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
}));
export type SocketRpcMachineReadServerOriginAuthorizationContextV1 = z.infer<typeof SocketRpcMachineReadServerOriginAuthorizationContextV1Schema>;

/** Exact reads whose safe projections the Home consumes; mutations never belong here. */
export const SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS: readonly string[] = Object.freeze([
  RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
  RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
  RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT,
  RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE,
  RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY,
  RPC_METHODS.DAEMON_EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE,
  SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
]);

export function isSocketRpcMachineReadServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcMachineReadServerOriginAuthorizationContextV1 {
  return SocketRpcMachineReadServerOriginAuthorizationContextV1Schema.safeParse(value).success;
}

/**
 * Server-minted custody for one authenticated socket connection presenting an
 * exact Session. Public callers cannot provide or parse this authority.
 */
export type SocketRpcCurrentSessionPresentationOriginAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN;
  sessionId: string;
  accountId: string;
  connectionId: string;
}>;

/** The exact server stamp for the closed external Action RPC seam. */
export const ACTION_API_SERVER_ORIGIN: SocketRpcActionApiServerOriginAuthorizationContext = Object.freeze({
  kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.ACTION_API_SERVER_ORIGIN,
});

/**
 * Generic client-call authorization is deliberately limited to the shapes
 * carrying a session id. The server-only Automation origin is transported in
 * the broader union but must never be accepted by this parser.
 */
export type SocketRpcSessionAuthorizationContext =
  | SocketRpcSessionBrowserAuthorizationContext
  | SocketRpcSessionReadAuthorizationContext
  | SocketRpcSessionWriteAuthorizationContext
  | SocketRpcSessionActionAuthorizationContext
  | SocketRpcSessionPermissionRespondAuthorizationContext;

export type SocketRpcAuthorizationContext =
  | import('../scm/workEvidence.js').ScmWorkEvidenceAuthorizationSelector
  | import('../scm/workEvidence.js').ScmWorkEvidenceAdmission
  | import('../machines/managed/managedInstallationV1.js').ManagedInstallationServerOriginV1
  | SocketRpcSessionAuthorizationContext
  | SessionFollowSourceKeyPrepareAuthorizationV1
  | SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext
  | SocketRpcSessionServerStartServerOriginAuthorizationContext
  | ManagedPluginWebhookOriginV1
  | SocketRpcActionApiServerOriginAuthorizationContext
  | SocketRpcMachineAccessLossServerOriginAuthorizationContext
  | SocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext
  | SocketRpcMachineReadServerOriginAuthorizationContextV1
  | SocketRpcCurrentSessionPresentationOriginAuthorizationContext;

const SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH = 512;

export function isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN;
}

export function isSocketRpcSessionServerStartServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcSessionServerStartServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_SERVER_START_SERVER_ORIGIN;
}

export function isSocketRpcActionApiServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcActionApiServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.ACTION_API_SERVER_ORIGIN;
}

export function isSocketRpcMachineAccessLossServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcMachineAccessLossServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.MACHINE_ACCESS_LOSS_SERVER_ORIGIN;
}

export function isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { kind?: unknown };
  return Object.hasOwn(candidate, 'kind')
    && Object.keys(candidate).length === 1
    && candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN;
}

export function isSocketRpcCurrentSessionPresentationOriginAuthorizationContext(
  value: unknown,
): value is SocketRpcCurrentSessionPresentationOriginAuthorizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as {
    kind?: unknown;
    sessionId?: unknown;
    accountId?: unknown;
    connectionId?: unknown;
  };
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 4
    || keys[0] !== 'accountId'
    || keys[1] !== 'connectionId'
    || keys[2] !== 'kind'
    || keys[3] !== 'sessionId'
    || candidate.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN
  ) return false;
  return [candidate.sessionId, candidate.accountId, candidate.connectionId].every((field) => (
    typeof field === 'string'
    && field.trim().length > 0
    && field.length <= SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH
  ));
}

export function parseSocketRpcAuthorizationContext(value: unknown): SocketRpcSessionAuthorizationContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { kind?: unknown; sessionId?: unknown; actor?: unknown; authentication?: unknown; authority?: unknown };
  if (candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_BROWSER) {
    const parsed = SocketRpcSessionBrowserAuthorizationContextSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_ACTION) {
    const parsed = SocketRpcSessionActionAuthorizationContextSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_READ
    || candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE) {
    const isRead = candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_READ;
    if (!Object.hasOwn(candidate, 'kind') || !Object.hasOwn(candidate, 'sessionId')
      || Object.keys(candidate).some((key) => key !== 'kind' && key !== 'sessionId' && (isRead || key !== 'authority'))) return null;
    if ('authority' in candidate && (isRead || !Object.hasOwn(candidate, 'authority') || candidate.authority !== 'sessionOwner')) return null;
    if (typeof candidate.sessionId !== 'string') return null;
    const sessionId = candidate.sessionId.trim();
    if (!sessionId || sessionId.length > SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH) return null;
    if (isRead) return { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_READ, sessionId };
    return {
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
      sessionId,
      ...(candidate.authority === 'sessionOwner' ? { authority: 'sessionOwner' as const } : {}),
    };
  }
  if (candidate.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND) return null;
  if (
    !Object.hasOwn(candidate, 'kind')
    || !Object.hasOwn(candidate, 'sessionId')
    || !Object.hasOwn(candidate, 'actor')
    || Object.keys(candidate).some((key) => key !== 'kind' && key !== 'sessionId' && key !== 'actor' && key !== 'authentication')
  ) {
    return null;
  }
  if (typeof candidate.sessionId !== 'string') return null;
  const sessionId = candidate.sessionId.trim();
  if (!sessionId || sessionId.length > SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH) return null;
  const actor = SessionPermissionDecisionActorV1Schema.safeParse(candidate.actor);
  if (!actor.success || actor.data.kind !== 'accountUser') return null;
  const authentication = candidate.authentication === undefined ? null
    : SessionPermissionDecisionAuthenticationV1Schema.safeParse(candidate.authentication);
  if (authentication && !authentication.success) return null;
  return {
    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
    sessionId,
    actor: actor.data,
    ...(authentication?.success ? { authentication: authentication.data } : {}),
  };
}
