import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../../rpc.js';
import { resolveMachineRpcGovernance, type MachineRpcGovernanceClassification } from './governanceV1.js';

export type { MachineRpcGovernanceClassification } from './governanceV1.js';

export type MachineRpcMethod =
  | (typeof RPC_METHODS)[keyof typeof RPC_METHODS]
  | (typeof SESSION_RPC_METHODS)[keyof typeof SESSION_RPC_METHODS];

export type MachineRpcRouteClass = 'server_required' | 'direct_ephemeral' | 'direct_medium_risk_receipted';

export type MachineRpcServerRequiredReason =
  | 'unclassified' | 'durable_session_write' | 'transcript_write'
  | 'pending_queue' | 'server_sequence_assignment' | 'reconnect_catch_up'
  | 'cross_device_fanout' | 'auth' | 'sharing' | 'billing'
  | 'automation' | 'account_change' | 'server_persistence'
  | 'destructive_or_recovery_mutation' | 'ambiguous';

// server_required covers durable/transcript/pending_queue/sequence/auth/sharing/billing/automation/account/fanout methods.

export type MachineRpcRoutePolicyScopeV1 = Readonly<{
  accountRequired: boolean;
  machineRequired: boolean;
  sessionRequired: boolean;
  serverRequired: boolean;
}>;

export type MachineRpcRoutePolicyV1 = Readonly<{
  method: string;
  routeClass: MachineRpcRouteClass;
  rationale: string;
  ownerPacket: 'PMS-5';
  rpcClassification: MachineRpcGovernanceClassification;
  actionSpecId?: string;
  commandReceiptRequired: boolean;
  scope: MachineRpcRoutePolicyScopeV1;
  serverRequiredReason?: MachineRpcServerRequiredReason;
}>;

export type MachineRpcRoutePolicyValidationResult = Readonly<{
  ok: boolean;
  policies: readonly MachineRpcRoutePolicyV1[];
  missingMethods: readonly string[];
  unknownMethods: readonly string[];
  duplicateMethods: readonly string[];
  invalidMethods: readonly string[];
}>;

const DIRECT_EPHEMERAL_SCOPE: MachineRpcRoutePolicyScopeV1 = Object.freeze({ accountRequired: true, machineRequired: true, sessionRequired: false, serverRequired: false });

const SERVER_REQUIRED_SCOPE: MachineRpcRoutePolicyScopeV1 = Object.freeze({ accountRequired: true, machineRequired: true, sessionRequired: false, serverRequired: true });

const SESSION_SERVER_REQUIRED_SCOPE: MachineRpcRoutePolicyScopeV1 = Object.freeze({ accountRequired: true, machineRequired: true, sessionRequired: true, serverRequired: true });

function directEphemeral(
  method: MachineRpcMethod,
  rationale: string,
): MachineRpcRoutePolicyV1 {
  return {
    method,
    routeClass: 'direct_ephemeral',
    rationale,
    ownerPacket: 'PMS-5',
    ...resolveMachineRpcGovernance(method),
    commandReceiptRequired: false,
    scope: DIRECT_EPHEMERAL_SCOPE,
  };
}

function serverRequired(
  method: MachineRpcMethod,
  serverRequiredReason: MachineRpcServerRequiredReason,
  rationale: string,
  scope: MachineRpcRoutePolicyScopeV1 = SERVER_REQUIRED_SCOPE,
): MachineRpcRoutePolicyV1 {
  return {
    method,
    routeClass: 'server_required',
    rationale,
    ownerPacket: 'PMS-5',
    ...resolveMachineRpcGovernance(method),
    commandReceiptRequired: false,
    scope,
    serverRequiredReason,
  };
}

function serverRequiredRows(
  methods: readonly MachineRpcMethod[],
  serverRequiredReason: MachineRpcServerRequiredReason,
  rationale: string,
  scope?: MachineRpcRoutePolicyScopeV1,
): readonly MachineRpcRoutePolicyV1[] {
  return methods.map((method) => serverRequired(method, serverRequiredReason, rationale, scope));
}

function actionSpecServerRequired(
  method: MachineRpcMethod,
  serverRequiredReason: MachineRpcServerRequiredReason,
  rationale: string,
  actionSpecId: string,
  scope?: MachineRpcRoutePolicyScopeV1,
): MachineRpcRoutePolicyV1 {
  return {
    ...serverRequired(method, serverRequiredReason, rationale, scope),
    rpcClassification: 'action_spec_bound',
    actionSpecId,
  };
}

const DIRECT_EPHEMERAL_POLICIES = Object.freeze([
  directEphemeral(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, 'Daemon-local execution run registry read; no server persistence, transcript write, or cross-device fanout.'),
  directEphemeral(RPC_METHODS.DAEMON_MEMORY_STATUS, 'Daemon-local memory worker status read with no mutation or server persistence.'),
  directEphemeral(RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET, 'Daemon-local memory settings read with no account mutation.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, 'Daemon-local voice inference worker status read.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST, 'Daemon-local installed/available model list read.'),
  directEphemeral(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS, 'Daemon-local model status read.'),
  directEphemeral(RPC_METHODS.DAEMON_EXTENSIONS_RELOAD_STATUS, 'Daemon-local extension reload status read.'),
  directEphemeral(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, 'Daemon-local contribution registry projection describe read.'),
  directEphemeral(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES, 'Daemon-local prompt asset type catalog read.'),
  directEphemeral(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS, 'Daemon-local prompt registry adapter catalog read.'),
  directEphemeral(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES, 'Daemon-local prompt registry source catalog read.'),
  directEphemeral(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET, 'Daemon-local marketplace source registry read.'),
  directEphemeral(RPC_METHODS.SCM_BACKEND_DESCRIBE, 'Daemon-local source-control backend capability describe read.'),
  directEphemeral(RPC_METHODS.CAPABILITIES_DESCRIBE, 'Daemon-local capability descriptor read.'),
] satisfies readonly MachineRpcRoutePolicyV1[]);

const SESSION_DURABLE_METHODS = [
  RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.STOP_SESSION, RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, RPC_METHODS.SESSION_FORK,
  RPC_METHODS.SESSION_PERMISSION_RESPOND, RPC_METHODS.SESSION_USER_ACTION_ANSWER, RPC_METHODS.SESSION_PERMISSION_MODE_SET,
  RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
  RPC_METHODS.DAEMON_SESSION_GOAL_GET,
  RPC_METHODS.DAEMON_SESSION_GOAL_SET,
  RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
  RPC_METHODS.APPROVAL_REQUEST_LIST, RPC_METHODS.APPROVAL_REQUEST_GET, RPC_METHODS.APPROVAL_REQUEST_CREATE, RPC_METHODS.APPROVAL_REQUEST_DECIDE,
  RPC_METHODS.SESSIONS_SUBAGENTS_LIST, RPC_METHODS.SESSIONS_SUBAGENTS_GET, RPC_METHODS.SESSIONS_SUBAGENTS_WATCH,
  RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT, RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS, RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE,
  SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS,
  SESSION_RPC_METHODS.SESSION_GOAL_GET,
  SESSION_RPC_METHODS.SESSION_GOAL_SET,
  SESSION_RPC_METHODS.SESSION_GOAL_CLEAR,
  SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
  SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
  SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
  SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE,
  SESSION_RPC_METHODS.SESSION_WORK_STATE_GET,
  SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
  SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, SESSION_RPC_METHODS.EXECUTION_RUN_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, SESSION_RPC_METHODS.EXECUTION_RUN_SEND, SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
  SESSION_RPC_METHODS.EXECUTION_RUN_LIST, SESSION_RPC_METHODS.EXECUTION_RUN_GET, SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
  SESSION_RPC_METHODS.SESSION_ROLLBACK,
] as const;

const TRANSFER_CONTROL_METHODS = [
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE, RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT, RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT, RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
] as const;

const LOCAL_MUTATION_METHODS = [
  RPC_METHODS.STOP_DAEMON,
  RPC_METHODS.DAEMON_TERMINAL_ENSURE,
  RPC_METHODS.DAEMON_TERMINAL_INPUT,
  RPC_METHODS.DAEMON_TERMINAL_RESIZE,
  RPC_METHODS.DAEMON_TERMINAL_CLOSE,
  RPC_METHODS.DAEMON_TERMINAL_RESTART,
  RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
  RPC_METHODS.DAEMON_EXTENSIONS_RELOAD,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL,
  RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET,
  RPC_METHODS.WRITE_FILE,
  RPC_METHODS.CREATE_DIRECTORY,
  RPC_METHODS.RENAME_PATH,
  RPC_METHODS.DELETE_PATH,
  RPC_METHODS.SCM_CHANGE_INCLUDE,
  RPC_METHODS.SCM_CHANGE_EXCLUDE,
  RPC_METHODS.SCM_CHANGE_DISCARD,
  RPC_METHODS.SCM_COMMIT_CREATE,
  RPC_METHODS.SCM_COMMIT_BACKOUT,
  RPC_METHODS.SCM_BRANCH_CREATE,
  RPC_METHODS.SCM_BRANCH_CHECKOUT,
  RPC_METHODS.SCM_BRANCH_MERGE,
  RPC_METHODS.SCM_BRANCH_REBASE,
  RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
  RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
  RPC_METHODS.SCM_WORKTREE_CREATE,
  RPC_METHODS.SCM_WORKTREE_REMOVE,
  RPC_METHODS.SCM_WORKTREE_PRUNE,
  RPC_METHODS.SCM_REMOTE_ADD,
  RPC_METHODS.SCM_REMOTE_SET_URL,
  RPC_METHODS.SCM_REMOTE_REMOVE,
  RPC_METHODS.SCM_REMOTE_FETCH,
  RPC_METHODS.SCM_REMOTE_PUSH,
  RPC_METHODS.SCM_REMOTE_PULL,
  RPC_METHODS.SCM_REMOTE_PUBLISH,
  RPC_METHODS.SCM_STASH_DROP,
  RPC_METHODS.SCM_STASH_POP,
  RPC_METHODS.SCM_STASH_APPLY,
  RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
  RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
  RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
  RPC_METHODS.SCM_REPOSITORY_CLONE,
  RPC_METHODS.SCM_REPOSITORY_INIT,
  RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
] as const;

const AMBIGUOUS_READ_OR_EXTERNAL_METHODS = [
  RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
  RPC_METHODS.DAEMON_MEMORY_SEARCH,
  RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
  RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
  RPC_METHODS.DAEMON_SERVER_WORK_STATUS,
  RPC_METHODS.DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST,
  RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST,
  RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
  RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
  RPC_METHODS.PREVIEW_ENV,
  RPC_METHODS.READ_FILE,
  RPC_METHODS.LIST_DIRECTORY,
  RPC_METHODS.GET_DIRECTORY_TREE,
  RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
  RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
  RPC_METHODS.STAT_FILE,
  RPC_METHODS.RIPGREP,
  RPC_METHODS.DIFFTASTIC,
  RPC_METHODS.SESSION_LOG_TAIL,
  RPC_METHODS.TRANSCRIPT_PAGE,
  RPC_METHODS.TRANSCRIPT_READ_AFTER,
  RPC_METHODS.TRANSCRIPT_FOLLOW,
  RPC_METHODS.TRANSCRIPT_SEARCH,
  RPC_METHODS.SCM_STATUS_SNAPSHOT,
  RPC_METHODS.SCM_DIFF_FILE,
  RPC_METHODS.SCM_DIFF_COMMIT,
  RPC_METHODS.SCM_LOG_LIST,
  RPC_METHODS.SCM_BRANCH_LIST,
  RPC_METHODS.SCM_STASH_LIST,
  RPC_METHODS.SCM_STASH_SHOW,
  RPC_METHODS.SCM_WORKTREES_ENRICHMENT,
  RPC_METHODS.SCM_PULL_REQUEST_LIST,
  RPC_METHODS.SCM_PULL_REQUEST_GET,
  RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
  RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
  RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE,
  RPC_METHODS.CAPABILITIES_DETECT,
  RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS,
  RPC_METHODS.BUGREPORT_GET_LOG_TAIL,
  RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE,
  RPC_METHODS.WORKSPACE_FAVICON_RESOLVE,
  SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST,
  SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST,
] as const;

const SERVER_PERSISTENCE_METHODS = [
  RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET,
  RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
  RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
  RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT,
  RPC_METHODS.TRANSCRIPT_IMPORT,
] as const;

const AUTOMATION_METHODS = [
  RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
  RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
  RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
  RPC_METHODS.CAPABILITIES_INVOKE,
] as const;

export const MACHINE_RPC_ROUTE_POLICIES = Object.freeze([
  ...DIRECT_EPHEMERAL_POLICIES,
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE, 'destructive_or_recovery_mutation', 'External-session link creation mutates durable session linkage and stays server-routed.', 'sessions.external.link.ensure'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH, 'destructive_or_recovery_mutation', 'External-session follow mutates follow leases and stays server-routed.', 'sessions.external.follow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH, 'destructive_or_recovery_mutation', 'External-session unfollow mutates follow leases and stays server-routed.', 'sessions.external.unfollow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET, 'destructive_or_recovery_mutation', 'External-session follow policy changes background follow state and stay server-routed.', 'sessions.external.followPolicy.set'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER, 'destructive_or_recovery_mutation', 'External-session takeover moves ownership into Happier runtime and stays server-routed.', 'sessions.external.takeover'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST, 'ambiguous', 'External-session candidate discovery can expose local provider metadata and stays server-routed.', 'sessions.external.candidates.list'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET, 'ambiguous', 'External-session status reads process/provider state and stay server-routed.', 'sessions.external.status.get'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE, 'reconnect_catch_up', 'External-session transcript page reads participate in reconnect/catch-up semantics and stay server-routed.', 'sessions.external.transcript.page'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER, 'reconnect_catch_up', 'External-session transcript read-after reads participate in reconnect/catch-up semantics and stay server-routed.', 'sessions.external.transcript.readAfter'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY, 'ambiguous', 'Legacy direct-session alias for external-session candidate discovery stays server-routed.', 'sessions.external.candidates.list'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session link creation stays server-routed.', 'sessions.external.link.ensure'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session follow stays server-routed.', 'sessions.external.follow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session unfollow stays server-routed.', 'sessions.external.unfollow'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session follow policy stays server-routed.', 'sessions.external.followPolicy.set'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY, 'ambiguous', 'Legacy direct-session alias for external-session status stays server-routed.', 'sessions.external.status.get'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY, 'reconnect_catch_up', 'Legacy direct-session alias for external-session transcript page stays server-routed.', 'sessions.external.transcript.page'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY, 'reconnect_catch_up', 'Legacy direct-session alias for external-session transcript read-after stays server-routed.', 'sessions.external.transcript.readAfter'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session alias for external-session takeover stays server-routed.', 'sessions.external.takeover'),
  actionSpecServerRequired(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY, 'destructive_or_recovery_mutation', 'Legacy direct-session takeoverPersist alias stays server-routed through external-session takeover.', 'sessions.external.takeover'),
  ...serverRequiredRows(SESSION_DURABLE_METHODS, 'durable_session_write', 'Session and execution-run lifecycle/state methods remain server-required because they can assign sequence, write durable session state, or fan out across devices.', SESSION_SERVER_REQUIRED_SCOPE),
  ...serverRequiredRows(TRANSFER_CONTROL_METHODS, 'server_persistence', 'Transfer control-plane RPC remains server-required; PMS bounded-transfer flows own direct byte movement and durable token/control reconciliation.'),
  ...serverRequiredRows(LOCAL_MUTATION_METHODS, 'destructive_or_recovery_mutation', 'Daemon-local or repository mutation is not low-risk direct RPC without a later ActionSpec command-receipt packet.'),
  ...serverRequiredRows(AMBIGUOUS_READ_OR_EXTERNAL_METHODS, 'ambiguous', 'Read or external-service behavior has privacy, access-policy, transcript, or side-effect ambiguity and must stay on the server route until proven safe.'),
  ...serverRequiredRows(SERVER_PERSISTENCE_METHODS, 'server_persistence', 'Server persistence or external provider state remains server-authoritative for this RPC family.'),
  ...serverRequiredRows(AUTOMATION_METHODS, 'automation', 'Automation and invocation surfaces stay server-required until separate policy and command-receipt semantics are accepted.'),
  serverRequired(RPC_METHODS.KILL_SESSION, 'durable_session_write', 'Session kill is a durable/destructive lifecycle mutation and must stay server-routed.', SESSION_SERVER_REQUIRED_SCOPE),
  serverRequired(RPC_METHODS.BASH, 'ambiguous', 'Shell execution has broad side-effect and access-policy ambiguity and must stay server-routed.'),
] satisfies readonly MachineRpcRoutePolicyV1[]);

const POLICY_BY_METHOD = new Map<string, MachineRpcRoutePolicyV1>();
for (const policy of MACHINE_RPC_ROUTE_POLICIES) {
  if (!POLICY_BY_METHOD.has(policy.method)) {
    POLICY_BY_METHOD.set(policy.method, policy);
  }
}

function createPolicyMap(
  policies: readonly MachineRpcRoutePolicyV1[],
): Map<string, MachineRpcRoutePolicyV1> {
  const policyMap = new Map<string, MachineRpcRoutePolicyV1>();
  for (const policy of policies) {
    if (!policyMap.has(policy.method)) {
      policyMap.set(policy.method, policy);
    }
  }
  return policyMap;
}

function collectRegisteredMachineRpcMethods(): readonly string[] {
  return Object.freeze([
    ...Object.values(RPC_METHODS),
    ...Object.values(SESSION_RPC_METHODS),
  ]);
}

export function resolveMachineRpcRoutePolicy(method: string): MachineRpcRoutePolicyV1 {
  return POLICY_BY_METHOD.get(method) ?? {
    method,
    routeClass: 'server_required',
    rationale: 'No deployed PMS-5 route policy row exists for this method; deny direct by default.',
    ownerPacket: 'PMS-5',
    rpcClassification: 'advisory_unclassified',
    commandReceiptRequired: false,
    scope: SERVER_REQUIRED_SCOPE,
    serverRequiredReason: 'unclassified',
  };
}

export function isMachineRpcDirectRoutePolicy(policy: Pick<MachineRpcRoutePolicyV1, 'routeClass'>): boolean {
  return policy.routeClass === 'direct_ephemeral' || policy.routeClass === 'direct_medium_risk_receipted';
}

export function validateMachineRpcRoutePolicies(
  policies: readonly MachineRpcRoutePolicyV1[] = MACHINE_RPC_ROUTE_POLICIES,
): MachineRpcRoutePolicyValidationResult {
  const registeredMethods = new Set(collectRegisteredMachineRpcMethods());
  const seen = new Set<string>();
  const duplicateMethods = new Set<string>();
  const unknownMethods = new Set<string>();
  const invalidMethods = new Set<string>();

  for (const policy of policies) {
    if (seen.has(policy.method)) {
      duplicateMethods.add(policy.method);
    }
    seen.add(policy.method);
    if (!registeredMethods.has(policy.method)) {
      unknownMethods.add(policy.method);
    }
    if (policy.ownerPacket !== 'PMS-5' || !policy.rationale.trim()) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass === 'server_required' && !policy.serverRequiredReason) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass !== 'server_required' && policy.serverRequiredReason) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass === 'direct_medium_risk_receipted' && !policy.commandReceiptRequired) {
      invalidMethods.add(policy.method);
    }
    if (policy.routeClass === 'direct_ephemeral' && policy.commandReceiptRequired) {
      invalidMethods.add(policy.method);
    }
    if (isMachineRpcDirectRoutePolicy(policy) && policy.rpcClassification === 'advisory_unclassified') {
      invalidMethods.add(policy.method);
    }
    if (isMachineRpcDirectRoutePolicy(policy) && (!policy.scope.accountRequired || !policy.scope.machineRequired || policy.scope.serverRequired)) {
      invalidMethods.add(policy.method);
    }
  }

  const missingMethods = [...registeredMethods].filter((method) => !seen.has(method)).sort();
  return {
    ok: missingMethods.length === 0
      && unknownMethods.size === 0
      && duplicateMethods.size === 0
      && invalidMethods.size === 0,
    policies,
    missingMethods,
    unknownMethods: [...unknownMethods].sort(),
    duplicateMethods: [...duplicateMethods].sort(),
    invalidMethods: [...invalidMethods].sort(),
  };
}

export function validateMachineRpcGrantAllowedMethods(methods: readonly string[]): Readonly<
  | { ok: true }
  | { ok: false; reasonCode: 'machine_rpc_requires_pms5_classification' | 'machine_rpc_method_server_required'; method: string }
>;
export function validateMachineRpcGrantAllowedMethods(
  methods: readonly string[],
  policies: readonly MachineRpcRoutePolicyV1[],
): Readonly<
  | { ok: true }
  | { ok: false; reasonCode: 'machine_rpc_requires_pms5_classification' | 'machine_rpc_method_server_required'; method: string }
>;
export function validateMachineRpcGrantAllowedMethods(
  methods: readonly string[],
  policies?: readonly MachineRpcRoutePolicyV1[],
): Readonly<
  | { ok: true }
  | { ok: false; reasonCode: 'machine_rpc_requires_pms5_classification' | 'machine_rpc_method_server_required'; method: string }
> {
  const policyMap = policies ? createPolicyMap(policies) : POLICY_BY_METHOD;
  for (const method of methods) {
    const policy = policyMap.get(method) ?? resolveMachineRpcRoutePolicy(method);
    if (policy.serverRequiredReason === 'unclassified') {
      return { ok: false, reasonCode: 'machine_rpc_requires_pms5_classification', method };
    }
    if (isMachineRpcDirectRoutePolicy(policy) && policy.rpcClassification === 'advisory_unclassified') {
      return { ok: false, reasonCode: 'machine_rpc_requires_pms5_classification', method };
    }
    if (!isMachineRpcDirectRoutePolicy(policy)) {
      return { ok: false, reasonCode: 'machine_rpc_method_server_required', method };
    }
  }
  return { ok: true };
}
