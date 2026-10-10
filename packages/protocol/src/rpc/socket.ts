import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  SessionPermissionDecisionActorV1Schema,
  type SessionPermissionDecisionActorV1,
} from '../sessions/permissions/v1.js';
import type { SessionCapabilityV1 } from '../sessions/access/sessionEffectiveAccessV1.js';
import type { ActionId } from '../actions/actionIds.js';
import type { SessionFollowSourceKeyPrepareAuthorizationV1 } from '../sessions/follow/sessionFollowSourceKeyPreparationV1.js';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
} from '../sessions/presentation/currentSessionPresentationV1.js';

import { z } from 'zod';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { ActionRequiredAuthoritySchema, type ActionRequiredAuthority } from '../actions/metadata.js';
import { CallerInputConstraintsV1Schema, type CallerInputConstraintsV1 } from '../auth/callerInputConstraintsV1.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from './methods.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AgentStartSessionCallerV1Schema } from '../account/settings/admitAgentStartV1.js';
import { AgentPermissionIntentV1Schema } from '../runtime/permissionIntentV1.js';
import { SessionInputCausalPermissionAuthorityV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { isRoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';

import type { ExternalActionMachineRpcExecutionV1, ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope } from '../actions/externalActionApi.js';
import { ExternalActionMachineRpcExecutionV1Schema, ExternalActionRequestEnvelopeSchema } from '../actions/externalActionApi.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { SocketRpcMachineAdmissionContextV1Schema, type SocketRpcMachineAdmissionContextV1 } from '../machines/machineAccessV1.js';
export { SocketRpcMachineAdmissionContextV1Schema, type SocketRpcMachineAdmissionContextV1 } from '../machines/machineAccessV1.js';

export const SOCKET_RPC_EVENTS = {
  REGISTER: 'rpc-register',
  REGISTERED: 'rpc-registered',
  UNREGISTER: 'rpc-unregister',
  UNREGISTERED: 'rpc-unregistered',
  ERROR: 'rpc-error',
  CALL: 'rpc-call',
  REQUEST: 'rpc-request',
  CANCEL: 'rpc-cancel',
  MACHINE_TRANSFER_ENVELOPE: 'machine-transfer-envelope',
} as const;

export type SocketRpcEvent = (typeof SOCKET_RPC_EVENTS)[keyof typeof SOCKET_RPC_EVENTS];

export const SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1 = 1 as const;

/**
 * Opaque, short-lived RPC correlation. The relay stamps a fresh value before it
 * reaches an RPC target, so a caller-local collision cannot cancel another
 * caller's request at that target.
 */
export const SocketRpcRequestIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(160));

/** Original host-admitted Action facts, distinct from relay request correlation. Every object is closed. */
export const SessionActionRpcOriginV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  caller: AgentStartSessionCallerV1Schema,
  sourceTurnId: z.string().trim().min(1),
  callerPermissionMode: asProtocolZod(AgentPermissionIntentV1Schema).nullable(),
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1Schema.nullable().optional(),
  workspaceWrites: z.enum(['allow', 'deny']).optional(),
  requestId: z.string().trim().min(1),
}).strict());
export type SessionActionRpcOriginV1 = Readonly<z.infer<typeof SessionActionRpcOriginV1Schema>>;

export const SocketRpcSessionActionAuthorizationContextSchema = lazyZodSchema(() => z.object({
  kind: z.literal('session.action'),
  sessionId: AgentStartSessionCallerV1Schema.shape.sessionId,
  origin: SessionActionRpcOriginV1Schema,
}).strict());
export type SocketRpcSessionActionAuthorizationContext = Readonly<z.infer<typeof SocketRpcSessionActionAuthorizationContextSchema>>;

/** Role Actions and the exact Home-admitted private workspace phases retain Session origin. */
export function isSessionActionRpcMethodV1(method: string): boolean {
  const unscoped = method.slice(method.lastIndexOf(':') + 1);
  return (unscoped.startsWith('session.') && isRoleActionIdV1(unscoped))
    || unscoped === SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
    || unscoped === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE;
}

export const SocketRpcCancellationPayloadSchema = lazyZodSchema(() => z.object({
  requestId: SocketRpcRequestIdSchema,
}).strict());

export type SocketRpcCancellationPayload = z.infer<typeof SocketRpcCancellationPayloadSchema>;

/** Non-secret routing metadata; file names, bytes and handles remain in the Session payload. */
export const SessionTransferRpcMethodV1Schema = lazyZodSchema(() => z.enum([
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
  ]));
export const SessionTransferRoutingV1Schema = lazyZodSchema(() => z.object({
  method: SessionTransferRpcMethodV1Schema,
  t: z.enum(['session_attachment_upload_v1', 'session_attachment_download_v1']),
  sessionId: asProtocolZod(SessionIdSchema),
}).strict().refine(value => ([RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT] as readonly string[]).includes(value.method)
  ? value.t === 'session_attachment_upload_v1'
  : value.t !== 'session_attachment_upload_v1'));

export type SessionTransferRoutingV1 = Readonly<z.infer<typeof SessionTransferRoutingV1Schema>>;

/** Exact private source workspace phase routing; the Home verifies the child socket before forwarding. */
export const WorkspaceSyncSourceContextV1Schema = lazyZodSchema(() => z.object({
  machineAdmission: SocketRpcMachineAdmissionContextV1Schema,
  callerAuthority: ActionRequiredAuthoritySchema,
  sessionActionOrigin: SessionActionRpcOriginV1Schema.optional(),
  callerInputConstraints: CallerInputConstraintsV1Schema.optional(),
  callerPermissionMode: asProtocolZod(AgentPermissionIntentV1Schema).nullable().optional(),
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1Schema.nullable().optional(),
  workspaceWrites: z.enum(['allow', 'deny']).optional(),
}).strict());
export type WorkspaceSyncSourceContextV1 = Readonly<z.infer<typeof WorkspaceSyncSourceContextV1Schema>>;
export const WorkspaceSyncSourceRoutingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  phase: z.enum(['prepare', 'finalize', 'commit', 'abort']),
  operationId: z.string().trim().min(1),
  accountServerId: z.string().trim().min(1),
  sourceMachineId: z.string().trim().min(1),
  sourceRootPath: z.string().trim().min(1),
  sourceSessionId: z.string().trim().min(1).optional(),
  sourceContext: WorkspaceSyncSourceContextV1Schema.optional(),
  originalActionEnvelope: z.lazy(() => ExternalActionRequestEnvelopeSchema).optional(),
}).strict());
export type WorkspaceSyncSourceRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncSourceRoutingV1Schema>>;

/** Original installed target packet, retained beside routing rather than inside its signed snapshot. */
export const WorkspaceSyncSourceExecutionV1Schema = lazyZodSchema(() => z.object({
  method: z.string().min(1),
  requestId: SocketRpcRequestIdSchema,
  params: StrictJsonValueSchema.optional(),
  externalActionExecution: z.lazy(() => ExternalActionMachineRpcExecutionV1Schema),
}).strict());
export type WorkspaceSyncSourceExecutionV1 = Readonly<z.infer<typeof WorkspaceSyncSourceExecutionV1Schema>>;

/** Target custody has its own phase binding; the moved Session need not live on this child. */
export const WorkspaceSyncTargetRoutingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  phase: z.enum(['preflight', 'prepare', 'release']),
  operationId: z.string().trim().min(1),
  accountServerId: z.string().trim().min(1),
  targetMachineId: z.string().trim().min(1),
  targetRootPath: z.string().trim().min(1),
  targetContext: WorkspaceSyncSourceContextV1Schema,
}).strict());
export type WorkspaceSyncTargetRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncTargetRoutingV1Schema>>;

/** The installed physical source writer retains the original child root for exact target custody phases. */
export const WorkspaceSyncSourceWriterTargetRoutingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  source: WorkspaceSyncSourceRoutingV1Schema.extend({ sourceContext: WorkspaceSyncSourceContextV1Schema }),
  target: WorkspaceSyncTargetRoutingV1Schema.omit({ targetContext: true }),
  sourceWriter: SocketRpcMachineAdmissionContextV1Schema.pick({ machineId: true, installationId: true }),
}).strict().superRefine((routing, ctx) => {
  if (routing.source.accountServerId !== routing.target.accountServerId) {
    ctx.addIssue({ code: 'custom', path: ['target', 'accountServerId'], message: 'Workspace phases must retain the same Home' });
  }
  if (routing.source.sourceMachineId !== routing.source.sourceContext.machineAdmission.machineId) {
    ctx.addIssue({ code: 'custom', path: ['source', 'sourceContext', 'machineAdmission', 'machineId'], message: 'Source context must retain its original child' });
  }
}));
export type WorkspaceSyncSourceWriterTargetRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncSourceWriterTargetRoutingV1Schema>>;

/** Installed P2 may request only the seed of its already admitted Target prepare. */
export const WorkspaceSyncSeedRoutingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sourceWriterTarget: WorkspaceSyncSourceWriterTargetRoutingV1Schema,
  target: WorkspaceSyncTargetRoutingV1Schema,
}).strict().superRefine((routing, ctx) => {
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
}));
export type WorkspaceSyncSeedRoutingV1 = Readonly<z.infer<typeof WorkspaceSyncSeedRoutingV1Schema>>;

export type SocketRpcRequestPayload = Readonly<{
  method: string;
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
  params: unknown;
  /**
   * Ephemeral transport correlation. Issuers use it to cancel their own
   * in-flight relay; the authenticated relay replaces it before target dispatch.
   */
  requestId?: string;
  authorization?: SocketRpcAuthorizationContext;
  /** Current Home admission for the exact Machine receiver, distinct from Session authority. */
  machineAdmission?: SocketRpcMachineAdmissionContextV1;
  externalActionExecution?: ExternalActionMachineRpcExecutionV1;
  timeoutMs?: number;
  transportResponseEnvelopeVersion?: typeof SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1;
}>;

export const SocketRpcTransportAcknowledgementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session.stop'),
    status: z.literal('stopped'),
  }).strict(),
]));

export type SocketRpcTransportAcknowledgementV1 =
  z.infer<typeof SocketRpcTransportAcknowledgementV1Schema>;

export const SocketRpcTransportResponseEnvelopeV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1),
  result: z.unknown(),
  acknowledgement: SocketRpcTransportAcknowledgementV1Schema.optional(),
}).strict().refine(
  (value) => Object.prototype.hasOwnProperty.call(value, 'result'),
  { message: 'result is required', path: ['result'] },
));

export type SocketRpcTransportResponseEnvelopeV1 =
  z.infer<typeof SocketRpcTransportResponseEnvelopeV1Schema>;

export const SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS = {
  SESSION_WRITE: 'session.write',
  SESSION_ACTION: 'session.action',
  SESSION_PERMISSION_RESPOND: 'session.permission.respond',
  AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN: 'automation.replyHandoff.serverOrigin',
  SESSION_SERVER_START_SERVER_ORIGIN: 'session.serverStart.serverOrigin',
  ACTION_API_SERVER_ORIGIN: 'action.api.serverOrigin',
  MACHINE_ACCESS_LOSS_SERVER_ORIGIN: 'machine.accessLoss.serverOrigin',
  LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN: 'localServices.preview.admission.serverOrigin',
  CURRENT_SESSION_PRESENTATION_ORIGIN: 'session.presentation.origin',
} as const;

export type SocketRpcAuthorizationContextKind =
  (typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS)[keyof typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS];

export type SocketRpcSessionWriteAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE;
  sessionId: string;
}>;

/**
 * Account identity proven by the authenticated server after resolving a
 * permission decision's session owner/share grant. It is intentionally not a
 * client-supplied input or a general caller identity carrier.
 */
export type SocketRpcSessionPermissionRespondAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND;
  sessionId: string;
  actor: Extract<SessionPermissionDecisionActorV1, Readonly<{ kind: 'accountUser' }>>;
}>;

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
  | SocketRpcSessionWriteAuthorizationContext
  | SocketRpcSessionActionAuthorizationContext
  | SocketRpcSessionPermissionRespondAuthorizationContext;

export type SocketRpcAuthorizationContext =
  | SocketRpcSessionAuthorizationContext
  | SessionFollowSourceKeyPrepareAuthorizationV1
  | SocketRpcAutomationReplyHandoffServerOriginAuthorizationContext
  | SocketRpcSessionServerStartServerOriginAuthorizationContext
  | SocketRpcActionApiServerOriginAuthorizationContext
  | SocketRpcMachineAccessLossServerOriginAuthorizationContext
  | SocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext
  | SocketRpcCurrentSessionPresentationOriginAuthorizationContext;

const SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH = 512;

/**
 * The exact Session authority a Session-owned write RPC requires. `sessionOwner`
 * exists because Lane 04 currently defines `stopSession` as owner-only: neither
 * `manageAccess` nor being the Run creator widens it.
 */
export type SocketRpcSessionWriteAuthorityV1 = SessionCapabilityV1 | 'sessionOwner';

export type SocketRpcSessionWriteClassificationV1 = Readonly<{
  method: string;
  authority: SocketRpcSessionWriteAuthorityV1;
  /** Machine/root admission is independent; supplied Session scope must be verified, never inferred from params. */
  optionalSessionScope?: true;
  /** Token calls are admitted only when the canonical row declares an Action. */
  actionId?: ActionId;
  serverMintedContext?: 'session.permission.respond' | 'session.presentation.origin';
  /**
   * True when the mutation must execute on the Session owner's daemon. A shared
   * collaborator holding the required capability needs no personal AccessKey for
   * that Machine, and the call is never forwarded to the caller's own user room.
   */
  routeToSessionOwnerDaemon: boolean;
}>;

/**
 * Closed matrix of Session RPCs, machine-routed Session controls and optional
 * Session proof on workspace SCM operations. Registration and final dispatch
 * consume this map; unclassified Session namespaces are unavailable rather than
 * inheriting authority from a prefix or daemon handler.
 */
type DeclaredSessionRpcMethod = (typeof SESSION_RPC_METHODS)[keyof typeof SESSION_RPC_METHODS];

/**
 * Every declared Session RPC chooses its authority here. The exhaustive Record
 * is intentional: extending SESSION_RPC_METHODS without classifying the new
 * method is a compile error, rather than silently granting submitAgentInput.
 */
const SESSION_RPC_DECLARED_AUTHORITIES = Object.freeze({
  [SESSION_RPC_METHODS.SESSION_WORKFLOW_STEP_WITHDRAW]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND]: { authority: 'submitAgentInput', actionId: 'session.message.send' },
  [SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PLUGIN_CATALOG_INVALIDATE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_WORK_STATE_GET]: { authority: 'readTranscript', actionId: 'session.work_state.get' },
  [SESSION_RPC_METHODS.SESSION_GOAL_GET]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_GOAL_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_GOAL_CLEAR]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PROVIDER_CLI_ATTACH_PREPARE]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION]: { authority: 'submitAgentInput', actionId: 'session.model.set' },
  [SESSION_RPC_METHODS.SESSION_ROLE_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_OVERRIDE_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_OVERRIDE_CLEAR]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_ADD]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_REMOVE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_NOTES_SET]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_ROLES_APPLY_TO_REPORTS]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_INPUT_CANCEL_EXACT_TURN_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_START]: 'submitAgentInput',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_SEND]: 'submitAgentInput',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STOP]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_GET]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_WAIT]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ACTION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_ROLLBACK]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_CHECKPOINT]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_RESTORE]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_OPEN_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_CANCEL_V1]: 'readTranscript',
} as const satisfies Record<DeclaredSessionRpcMethod, SocketRpcSessionWriteAuthorityV1 | Pick<SocketRpcSessionWriteClassificationV1, 'authority' | 'actionId'>>);

const SESSION_RPC_AUTHORIZATION_ROWS: readonly SocketRpcSessionWriteClassificationV1[] =
  Object.entries(SESSION_RPC_DECLARED_AUTHORITIES).map(([method, declaration]) => Object.freeze({
    method,
    ...(typeof declaration === 'string' ? { authority: declaration } : declaration),
    routeToSessionOwnerDaemon: true,
  }));

const ADDITIONAL_SESSION_RPC_AUTHORIZATION_ROWS = [
  ...[
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
  ].map((method) => ({ method, authority: 'submitAgentInput' as const, actionId: 'session.message.send' as const, routeToSessionOwnerDaemon: true })),
  { method: RPC_METHODS.SESSION_LOG_TAIL, authority: 'readTranscript', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_PAGE, authority: 'readTranscript', actionId: 'transcript.page', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_READ_AFTER, authority: 'readTranscript', actionId: 'transcript.readAfter', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_FOLLOW, authority: 'readTranscript', actionId: 'session.transcript.get', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_UNFOLLOW, authority: 'readTranscript', actionId: 'transcript.unfollow', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_SEARCH, authority: 'readTranscript', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_IMPORT, authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD, authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  { method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  { method: CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD, authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  { method: CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD, authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  { method: 'session.permission_mode.set', authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.SESSION_PERMISSION_RESPOND, authority: 'approveRuntimePermissions', actionId: 'session.permission.respond', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  { method: 'permission', authority: 'approveRuntimePermissions', actionId: 'session.permission.respond', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  { method: 'session.permission.remote.grants.list', authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: 'session.permission.remote.grants.revoke', authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: 'session.user_action.answer', authority: 'submitAgentInput', actionId: 'session.user_action.answer', routeToSessionOwnerDaemon: true },
  { method: 'abort', authority: 'submitAgentInput', actionId: 'session.message.send', routeToSessionOwnerDaemon: true },
] as const satisfies readonly SocketRpcSessionWriteClassificationV1[];

export const API_TOKEN_SOCKET_EVENT_ACTIONS = Object.freeze({ message: 'session.message.send' } as const);

const SOCKET_RPC_SESSION_WRITE_AUTHORIZATION: ReadonlyMap<string, SocketRpcSessionWriteClassificationV1> = new Map(
  ([
    ...SESSION_RPC_AUTHORIZATION_ROWS,
    ...ADDITIONAL_SESSION_RPC_AUTHORIZATION_ROWS,
    ...[
      RPC_METHODS.SCM_PULL_REQUEST_LIST,
      RPC_METHODS.SCM_PULL_REQUEST_GET,
      RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE,
      RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST,
      RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ,
      RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT,
      RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO,
      RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE,
      RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_CLEAR,
      RPC_METHODS.SCM_DIFF_SUMMARY_REVIEWED_MARK,
      RPC_METHODS.SCM_DIFF_SUMMARY_REVIEWED_UNMARK,
      'scm.diffSummary.commitPlan.accept',
      'scm.diffSummary.commitPlan.stop',
      'scm.diffSummary.commitPlan.includeHookChanges',
      'scm.diffSummary.commitPlan.cancel',
      'scm.diffSummary.commitPlan.recover',
    ].map((method) => ({ method, authority: 'readTranscript' as const, optionalSessionScope: true as const, routeToSessionOwnerDaemon: false })),
    ...[
      RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE,
      RPC_METHODS.SCM_DIFF_SUMMARY_REFINE,
      RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS,
      RPC_METHODS.SCM_DIFF_SUMMARY_ADD_OUTPUTS,
    ].map((method) => ({ method, authority: 'submitAgentInput' as const, optionalSessionScope: true as const, routeToSessionOwnerDaemon: false })),
    { method: RPC_METHODS.STOP_SESSION, authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.SESSION_AGENT_TRANSITION, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
  ] as const satisfies readonly SocketRpcSessionWriteClassificationV1[])
    .map((row) => [row.method, Object.freeze(row)] as const),
);

const SOCKET_RPC_PROVIDER_STARTING_METHODS = new Set<string>([
  RPC_METHODS.SPAWN_HAPPY_SESSION,
  RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
  RPC_METHODS.SESSION_SPAWN_NEW,
  RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
  RPC_METHODS.SESSION_FORK,
  RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
  RPC_METHODS.SESSION_AGENT_TRANSITION,
  RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
  RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER,
  RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
  RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
]);

function resolveUnscopedSocketRpcMethod(method: string): string {
  const separatorIndex = method.lastIndexOf(':');
  if (separatorIndex < 0) return method;
  return method.slice(separatorIndex + 1);
}

/**
 * The exact authority and daemon target for a Session-owned write RPC, or null
 * when the method is not an admitted Session write.
 */
export function resolveSocketRpcSessionWriteAuthorization(
  method: string,
): SocketRpcSessionWriteClassificationV1 | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  const rule = SOCKET_RPC_SESSION_WRITE_AUTHORIZATION.get(normalized) ?? null;
  return rule?.authority === 'readTranscript' ? null : rule;
}

export function resolveSocketRpcSessionWriteAuthorizationMethod(method: string): string | null {
  return resolveSocketRpcSessionWriteAuthorization(method)?.method ?? null;
}

/** The single closed Session RPC method-authorization map used by registration and dispatch. */
export function resolveSocketRpcSessionAuthorization(
  method: string,
): SocketRpcSessionWriteClassificationV1 | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return SOCKET_RPC_SESSION_WRITE_AUTHORIZATION.get(normalized) ?? null;
}

/** Namespaces whose Session-scoped registration is closed by the map above. */
export function isSocketRpcSessionAuthorizationNamespace(method: string): boolean {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return normalized.startsWith('session.')
    || normalized.startsWith('execution.run.')
    || normalized.startsWith('managedServer.endpoint.')
    || normalized.startsWith('transcript.');
}

/**
 * This includes the retained `permission` wire alias only so the server can
 * stamp the exact same account actor at the authenticated boundary. The daemon
 * still requires that stamp and does not grant actor authority to raw/local
 * callers.
 */
export function resolveSocketRpcSessionPermissionDecisionAuthorizationMethod(method: string): string | null {
  const rule = resolveSocketRpcSessionAuthorization(method);
  return rule?.serverMintedContext === 'session.permission.respond' ? rule.method : null;
}

export function resolveSocketRpcProviderStartingMethod(method: string): string | null {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return SOCKET_RPC_PROVIDER_STARTING_METHODS.has(normalized) ? normalized : null;
}

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
  const candidate = value as { kind?: unknown; sessionId?: unknown; actor?: unknown };
  if (candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_ACTION) {
    const parsed = SocketRpcSessionActionAuthorizationContextSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (candidate.kind === SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE) {
    if (!Object.hasOwn(candidate, 'kind') || !Object.hasOwn(candidate, 'sessionId')
      || Object.keys(candidate).some((key) => key !== 'kind' && key !== 'sessionId')) return null;
    if (typeof candidate.sessionId !== 'string') return null;
    const sessionId = candidate.sessionId.trim();
    if (!sessionId || sessionId.length > SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH) return null;
    return {
      kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
      sessionId,
    };
  }
  if (candidate.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND) return null;
  if (
    !Object.hasOwn(candidate, 'kind')
    || !Object.hasOwn(candidate, 'sessionId')
    || !Object.hasOwn(candidate, 'actor')
    || Object.keys(candidate).some((key) => key !== 'kind' && key !== 'sessionId' && key !== 'actor')
  ) {
    return null;
  }
  if (typeof candidate.sessionId !== 'string') return null;
  const sessionId = candidate.sessionId.trim();
  if (!sessionId || sessionId.length > SOCKET_RPC_AUTHORIZATION_SESSION_ID_MAX_LENGTH) return null;
  const actor = SessionPermissionDecisionActorV1Schema.safeParse(candidate.actor);
  if (!actor.success || actor.data.kind !== 'accountUser') return null;
  return {
    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
    sessionId,
    actor: actor.data,
  };
}
