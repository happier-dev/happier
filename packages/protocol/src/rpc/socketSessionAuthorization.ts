import type { ActionId } from '../actions/actionIds.js';
import type { SessionCapabilityV1 } from '../sessions/access/sessionEffectiveAccessV1.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from './methods.js';
import type { SocketRpcSessionReadAuthorizationContext, SocketRpcSessionWriteAuthorizationContext } from './socket.js';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
} from './methods.js';

export const SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS = {
  SESSION_READ: 'session.read',
  SESSION_BROWSER: 'session.browser',
  SESSION_WRITE: 'session.write',
  SESSION_ACTION: 'session.action',
  SESSION_PERMISSION_RESPOND: 'session.permission.respond',
  AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN: 'automation.replyHandoff.serverOrigin',
  SESSION_SERVER_START_SERVER_ORIGIN: 'session.serverStart.serverOrigin',
  MANAGED_PLUGIN_WEBHOOK_SERVER_ORIGIN: 'plugin.webhook.managed.serverOrigin',
  ACTION_API_SERVER_ORIGIN: 'action.api.serverOrigin',
  MACHINE_ACCESS_LOSS_SERVER_ORIGIN: 'machine.accessLoss.serverOrigin',
  LOCAL_SERVICES_PREVIEW_ADMISSION_SERVER_ORIGIN: 'localServices.preview.admission.serverOrigin',
  MACHINE_READ_SERVER_ORIGIN: 'machine.read.serverOrigin',
  MANAGED_INSTALLATION_SERVER_ORIGIN: 'machine.managedInstallation.serverOrigin',
  CURRENT_SESSION_PRESENTATION_ORIGIN: 'session.presentation.origin',
} as const;

export type SocketRpcAuthorizationContextKind =
  (typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS)[keyof typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS];

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
  /** The same method also serves detached Runs under exact Machine admission. */
  machineScope?: true;
  /** New provider work or workspace mutation requires the Session owner's current Machine access at RPC admission. */
  startsAgentWork?: true;
  /** Token calls are admitted only when the canonical row declares an Action. */
  actionId?: ActionId;
  serverMintedContext?: 'session.read' | 'session.permission.respond' | 'session.presentation.origin';
  /** Decoded request field bound to the server-admitted Session at the daemon. */
  sessionIdParam?: 'sourceSessionId' | 'parentSessionId';
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
type RpcMethodValue = (typeof RPC_METHODS)[keyof typeof RPC_METHODS]
  | Extract<(typeof import('./methods.js'))[keyof typeof import('./methods.js')], string>;
type DeclaredSessionRpcMethod = (typeof SESSION_RPC_METHODS)[keyof typeof SESSION_RPC_METHODS];
type DeclaredSessionRpcAuthority = SocketRpcSessionWriteAuthorityV1 | (
  Pick<SocketRpcSessionWriteClassificationV1, 'authority' | 'actionId' | 'machineScope' | 'startsAgentWork' | 'serverMintedContext' | 'sessionIdParam'>
  & Partial<Pick<SocketRpcSessionWriteClassificationV1, 'routeToSessionOwnerDaemon' | 'optionalSessionScope'>>
) | null;

/**
 * Every declared Session RPC and session.* method chooses its authority here.
 * Adding a Session method without classifying it is a compile error, rather
 * than silently granting submitAgentInput.
 */
const SESSION_RPC_DECLARED_AUTHORITIES = Object.freeze({
  [SESSION_RPC_METHODS.SESSION_COMPACT]: { authority: 'submitAgentInput', actionId: 'session.compact', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_WORKFLOW_STEP_WITHDRAW]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND]: { authority: 'submitAgentInput', actionId: 'session.message.send' },
  [SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY]: { authority: 'sessionOwner', actionId: 'session.message.reply' },
  [SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY_OBSERVE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PLUGIN_CATALOG_INVALIDATE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_AGENT_START_SELECTION_READ_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_WORK_STATE_GET]: { authority: 'readTranscript', actionId: 'session.work_state.get' },
  [SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE]: { authority: 'submitAgentInput', actionId: 'session.needs_you.raise' },
  [SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1]: { authority: 'submitAgentInput', actionId: 'session.user_action.answer', serverMintedContext: 'session.permission.respond' },
  [SESSION_RPC_METHODS.SESSION_GOAL_GET]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_GOAL_SET]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_GOAL_CLEAR]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_GUARD_NOTICE]: 'sessionOwner',
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
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR]: 'submitAgentInput',
  // A raw terminal on the Agent (keystrokes reach its TUI, including its own prompts): the Session owner only.
  [SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_INPUT]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_DETACH]: 'sessionOwner',
  [SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_INPUT_CANCEL_EXACT_TURN_V1]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST]: 'readTranscript',
  [SESSION_RPC_METHODS.EXECUTION_RUN_START]: { authority: 'submitAgentInput', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE]: { authority: 'submitAgentInput', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START]: { authority: 'sessionOwner', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1]: { authority: 'sessionOwner', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_SEND]: { authority: 'submitAgentInput', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START]: { authority: 'sessionOwner', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2]: { authority: 'sessionOwner', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1]: { authority: 'sessionOwner', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ]: { authority: 'readTranscript', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL]: { authority: 'sessionOwner', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1]: { authority: 'sessionOwner', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_STOP]: { authority: 'sessionOwner', machineScope: true },
  [SESSION_RPC_METHODS.SESSION_DELETE]: { authority: 'sessionOwner', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_LIST]: { authority: 'readTranscript', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_GET]: { authority: 'readTranscript', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER]: { authority: 'readTranscript', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_WAIT]: { authority: 'readTranscript', machineScope: true },
  [SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1]: 'sessionOwner',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ACTION]: { authority: 'sessionOwner', machineScope: true, startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_ROLLBACK]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_CHECKPOINT]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_RESTORE]: { authority: 'submitAgentInput', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START]: { authority: 'sessionOwner', startsAgentWork: true },
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP]: 'submitAgentInput',
  [SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_OPEN_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1]: 'readTranscript',
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_CANCEL_V1]: 'readTranscript',
  // Owner-only, exactly what its former unclassified same-Account room forwarding allowed. Not
  // `startsAgentWork`: that server check never applied to custody and would refuse startup custody
  // before the Session has committed input.
  [SESSION_RPC_METHODS.SESSION_MANAGED_SERVICES_CUSTODY_V1]: 'sessionOwner',
  [RPC_METHODS.SESSION_LOG_TAIL]: { authority: 'readTranscript', routeToSessionOwnerDaemon: true },
  [CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD]: { authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  [CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD]: { authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  [CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD]: { authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  [CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD]: { authority: 'sessionOwner', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.presentation.origin' },
  ['session.permission_mode.set']: { authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  [RPC_METHODS.SESSION_PERMISSION_RESPOND]: { authority: 'approveRuntimePermissions', actionId: 'session.permission.respond', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  // Mediator attribution comes from trusted code on the Session owner's Account,
  // never a collaborator's broader message/permission capabilities.
  ['session.permission.remote.pending.list']: { authority: 'sessionOwner', actionId: 'session.permission.remote.pending.list', routeToSessionOwnerDaemon: true },
  ['session.permission.remote.respond']: { authority: 'sessionOwner', actionId: 'session.permission.remote.respond', routeToSessionOwnerDaemon: true },
  ['session.user_action.remote.answer']: { authority: 'sessionOwner', actionId: 'session.user_action.remote.answer', routeToSessionOwnerDaemon: true },
  ['session.permission.remote.grants.list']: { authority: 'submitAgentInput', actionId: 'session.permission.remote.grants.list', routeToSessionOwnerDaemon: true },
  ['session.permission.remote.grants.revoke']: { authority: 'submitAgentInput', actionId: 'session.permission.remote.grants.revoke', routeToSessionOwnerDaemon: true },
  ['session.user_action.answer']: { authority: 'submitAgentInput', actionId: 'session.user_action.answer', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  ['session.update.post']: { authority: 'submitAgentInput', actionId: 'session.update.post', routeToSessionOwnerDaemon: true },
  [RPC_METHODS.SESSION_FORK]: { authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
  [RPC_METHODS.SESSION_FORK_PROVIDER_SAFE]: { authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
  [RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY]: { authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
  [RPC_METHODS.SESSION_AGENT_TRANSITION]: { authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
  [RPC_METHODS.SESSION_CONTINUATION_INSPECT]: { authority: 'readTranscript', serverMintedContext: 'session.read', sessionIdParam: 'sourceSessionId', routeToSessionOwnerDaemon: false },
  [RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH]: { authority: 'readTranscript', serverMintedContext: 'session.read', sessionIdParam: 'sourceSessionId', routeToSessionOwnerDaemon: false },
  [RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW]: { authority: 'readTranscript', serverMintedContext: 'session.read', routeToSessionOwnerDaemon: false },
  // New Session creation has Machine/Action admission and no existing Session proof.
  [RPC_METHODS.SESSION_SPAWN_NEW]: null,
} as const) satisfies Record<DeclaredSessionRpcMethod | Extract<RpcMethodValue, `session.${string}`>, DeclaredSessionRpcAuthority>;

const SESSION_RPC_AUTHORIZATION_ROWS: readonly SocketRpcSessionWriteClassificationV1[] =
  Object.entries(SESSION_RPC_DECLARED_AUTHORITIES).flatMap(([method, declaration]) => declaration === null ? [] : [Object.freeze({
    method,
    routeToSessionOwnerDaemon: true,
    ...(typeof declaration === 'string' ? { authority: declaration } : declaration),
  })]);

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
  { method: RPC_METHODS.TRANSCRIPT_PAGE, authority: 'readTranscript', actionId: 'transcript.page', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_READ_AFTER, authority: 'readTranscript', actionId: 'transcript.readAfter', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_FOLLOW, authority: 'readTranscript', actionId: 'session.transcript.get', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_UNFOLLOW, authority: 'readTranscript', actionId: 'transcript.unfollow', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_SEARCH, authority: 'readTranscript', routeToSessionOwnerDaemon: true },
  { method: RPC_METHODS.TRANSCRIPT_IMPORT, authority: 'submitAgentInput', routeToSessionOwnerDaemon: true },
  { method: 'permission', authority: 'approveRuntimePermissions', actionId: 'session.permission.respond', routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  { method: RPC_METHODS.APPROVAL_REQUEST_DECIDE, authority: 'submitAgentInput', actionId: 'approval.request.decide', machineScope: true, routeToSessionOwnerDaemon: true, serverMintedContext: 'session.permission.respond' },
  { method: 'abort', authority: 'submitAgentInput', actionId: 'session.turn.cancel', routeToSessionOwnerDaemon: true },
  { method: 'switch', authority: 'submitAgentInput', actionId: 'session.control.switch', routeToSessionOwnerDaemon: true },
  { method: 'skills.read', authority: 'readTranscript', actionId: 'skills.read', routeToSessionOwnerDaemon: true },
] as const satisfies readonly SocketRpcSessionWriteClassificationV1[];

export const API_TOKEN_SOCKET_EVENT_ACTIONS = Object.freeze({ message: 'session.message.send' } as const);

const SOCKET_RPC_SESSION_WRITE_AUTHORIZATION: ReadonlyMap<string, SocketRpcSessionWriteClassificationV1> = new Map(
  ([
    ...SESSION_RPC_AUTHORIZATION_ROWS,
    ...ADDITIONAL_SESSION_RPC_AUTHORIZATION_ROWS,
    ...[
      RPC_METHODS.SCM_BRANCH_LIST,
      RPC_METHODS.SCM_WORK_EVIDENCE_READ,
      RPC_METHODS.SCM_PULL_REQUEST_LIST,
      RPC_METHODS.SCM_PULL_REQUEST_GET,
      RPC_METHODS.SCM_DIFF_FILE,
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
      RPC_METHODS.SCM_CHANGE_DISCARD,
      'scm.suggestion.apply',
      RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE,
      RPC_METHODS.SCM_DIFF_SUMMARY_DRAFT_PULL_REQUEST,
      RPC_METHODS.SCM_DIFF_SUMMARY_REFINE,
      RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS,
      RPC_METHODS.SCM_DIFF_SUMMARY_ADD_OUTPUTS,
    ].map((method) => ({ method, authority: 'submitAgentInput' as const, optionalSessionScope: true as const, routeToSessionOwnerDaemon: false })),
    { method: RPC_METHODS.STOP_SESSION, authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH, authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_OPTIONS, authority: 'sessionOwner', routeToSessionOwnerDaemon: false, serverMintedContext: 'session.read' },
    { method: RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_CHOICES, authority: 'sessionOwner', routeToSessionOwnerDaemon: false, serverMintedContext: 'session.read' },
    { method: RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_SET, authority: 'sessionOwner', routeToSessionOwnerDaemon: false },
    // Child-agent rosters and transcripts are Session content on the custodian's daemon:
    // a Machine Use grant never stands in for access to the parent Session.
    { method: RPC_METHODS.SESSIONS_SUBAGENTS_LIST, authority: 'readTranscript', routeToSessionOwnerDaemon: false, serverMintedContext: 'session.read' },
    { method: RPC_METHODS.SESSIONS_SUBAGENTS_GET, authority: 'readTranscript', routeToSessionOwnerDaemon: false, serverMintedContext: 'session.read' },
    { method: RPC_METHODS.SESSIONS_SUBAGENTS_WATCH, authority: 'readTranscript', routeToSessionOwnerDaemon: false, serverMintedContext: 'session.read', sessionIdParam: 'parentSessionId' },
    ...[
      RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT,
      RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS,
      RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE,
    ].map((method) => ({ method, authority: 'sessionOwner' as const, routeToSessionOwnerDaemon: false, sessionIdParam: 'parentSessionId' as const })),
    { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_CONFIRMED_BACKGROUND, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
    { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, authority: 'submitAgentInput', routeToSessionOwnerDaemon: false },
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
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_CONFIRMED_BACKGROUND,
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

/**
 * Session context for a caller that holds the Session's own Account on the Session's host machine
 * (the same-OS-user local channel). Only rows whose context the server mints from the Session id
 * alone qualify. Rows needing a server-proven actor or connection (permission decisions, current
 * presentation), a fresh Machine-access check (`startsAgentWork`) or a second Session's access
 * (`sessionIdParam`, optional Session scope) stay on the server path and return null.
 * A trusted host may retain an Execution Run start it already admitted; this
 * argument is host context, never a public packet field or client admission claim.
 */
export function resolveSocketRpcSameAccountSessionAuthorizationV1(
  method: string,
  sessionId: string,
  admission?: Readonly<{ admittedAgentStart: boolean }>,
): SocketRpcSessionReadAuthorizationContext | SocketRpcSessionWriteAuthorizationContext | null {
  const rule = resolveSocketRpcSessionAuthorization(method);
  if (!rule || !sessionId || rule.optionalSessionScope || rule.sessionIdParam) return null;
  if (rule.startsAgentWork && !(admission?.admittedAgentStart === true
    && rule.method === SESSION_RPC_METHODS.EXECUTION_RUN_START)) return null;
  if (rule.serverMintedContext === 'session.read') return { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_READ, sessionId };
  if (rule.serverMintedContext !== undefined) return null;
  // This caller holds the Session's own Account: owner-classified rows and an
  // admitted Run start carry the same owner proof Home forwards.
  const owner = rule.authority === 'sessionOwner' || rule.method === SESSION_RPC_METHODS.EXECUTION_RUN_START;
  return { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId,
    ...(owner ? { authority: 'sessionOwner' as const } : {}) };
}

/** Namespaces whose Session-scoped registration is closed by the map above. */
export function isSocketRpcSessionAuthorizationNamespace(method: string): boolean {
  const normalized = resolveUnscopedSocketRpcMethod(String(method ?? '').trim());
  return normalized.startsWith('session.')
    || normalized.startsWith('discussion.')
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
