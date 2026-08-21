export const RPC_METHODS = {
  SPAWN_HAPPY_SESSION: 'spawn-happy-session',
  SPAWN_HAPPY_SESSION_PROVIDER_SAFE: 'spawn-happy-session.provider-safe.v1',
  STOP_SESSION: 'stop-session',
  STOP_DAEMON: 'stop-daemon',
  DAEMON_SPAWN_SESSION_RESOLVE: 'daemon.spawnSession.resolve',
  DAEMON_SPAWN_SESSION_ABANDON: 'daemon.spawnSession.abandon',
  DAEMON_EXECUTION_RUNS_LIST: 'daemon.executionRuns.list',
  DAEMON_TERMINAL_ENSURE: 'daemon.terminal.ensure',
  DAEMON_TERMINAL_STREAM_READ: 'daemon.terminal.stream.read',
  DAEMON_TERMINAL_INPUT: 'daemon.terminal.input',
  DAEMON_TERMINAL_RESIZE: 'daemon.terminal.resize',
  DAEMON_TERMINAL_CLOSE: 'daemon.terminal.close',
  DAEMON_TERMINAL_RESTART: 'daemon.terminal.restart',
  DAEMON_MEMORY_SEARCH: 'daemon.memory.search',
  DAEMON_MEMORY_GET_WINDOW: 'daemon.memory.getWindow',
  DAEMON_MEMORY_ENSURE_UP_TO_DATE: 'daemon.memory.ensureUpToDate',
  DAEMON_MEMORY_STATUS: 'daemon.memory.status',
  DAEMON_SERVER_WORK_STATUS: 'daemon.serverWork.status',
  DAEMON_MEMORY_SETTINGS_GET: 'daemon.memory.settings.get',
  DAEMON_MEMORY_SETTINGS_SET: 'daemon.memory.settings.set',
  DAEMON_MCP_SERVERS_TEST: 'daemon.mcpServers.test',
  DAEMON_MCP_SERVERS_DETECT: 'daemon.mcpServers.detect',
  DAEMON_MCP_SERVERS_PREVIEW: 'daemon.mcpServers.preview',
  DAEMON_BULK_TRANSFER_UPLOAD_INIT: 'daemon.bulkTransfer.upload.init',
  DAEMON_BULK_TRANSFER_UPLOAD_CHUNK: 'daemon.bulkTransfer.upload.chunk',
  DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE: 'daemon.bulkTransfer.upload.finalize',
  DAEMON_BULK_TRANSFER_UPLOAD_ABORT: 'daemon.bulkTransfer.upload.abort',
  DAEMON_BULK_TRANSFER_DOWNLOAD_INIT: 'daemon.bulkTransfer.download.init',
  DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK: 'daemon.bulkTransfer.download.chunk',
  DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE: 'daemon.bulkTransfer.download.finalize',
  DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT: 'daemon.bulkTransfer.download.abort',
  DAEMON_PROMPT_ASSETS_LIST_TYPES: 'daemon.promptAssets.listTypes',
  DAEMON_PROMPT_ASSETS_DISCOVER: 'daemon.promptAssets.discover',
  DAEMON_PROMPT_ASSETS_UPLOAD_INIT: 'daemon.promptAssets.upload.init',
  DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK: 'daemon.promptAssets.upload.chunk',
  DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE: 'daemon.promptAssets.upload.finalize',
  DAEMON_PROMPT_ASSETS_UPLOAD_ABORT: 'daemon.promptAssets.upload.abort',
  DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT: 'daemon.promptAssets.download.init',
  DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK: 'daemon.promptAssets.download.chunk',
  DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE: 'daemon.promptAssets.download.finalize',
  DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT: 'daemon.promptAssets.download.abort',
  DAEMON_PROMPT_ASSETS_DELETE: 'daemon.promptAssets.delete',
  WORKSPACE_ANCHORS_RESOLVE: 'workspace.anchors.resolve',
  WORKSPACE_FAVICON_RESOLVE: 'workspace.favicon.resolve',
  DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS: 'daemon.promptRegistry.listAdapters',
  DAEMON_PROMPT_REGISTRY_LIST_SOURCES: 'daemon.promptRegistry.listSources',
  DAEMON_PROMPT_REGISTRY_SCAN_SOURCE: 'daemon.promptRegistry.scanSource',
  DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT: 'daemon.promptRegistry.download.init',
  DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK: 'daemon.promptRegistry.download.chunk',
  DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE: 'daemon.promptRegistry.download.finalize',
  DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT: 'daemon.promptRegistry.download.abort',
  DAEMON_PROMPT_REGISTRY_INSTALL: 'daemon.promptRegistry.install',
  DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST: 'daemon.directSessions.candidates.list',
  DAEMON_DIRECT_SESSION_LINK_ENSURE: 'daemon.directSessions.link.ensure',
  DAEMON_DIRECT_SESSION_ATTACH: 'daemon.directSessions.attach',
  DAEMON_DIRECT_SESSION_DETACH: 'daemon.directSessions.detach',
  DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET: 'daemon.directSessions.followPolicy.set',
  DAEMON_DIRECT_SESSION_STATUS_GET: 'daemon.directSessions.status.get',
  DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE: 'daemon.directSessions.transcript.page',
  DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER: 'daemon.directSessions.transcript.readAfter',
  DAEMON_DIRECT_SESSION_TAKEOVER: 'daemon.directSessions.takeover',
  DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST: 'daemon.directSessions.takeoverPersist',
  DAEMON_SESSION_GOAL_GET: 'daemon.sessionGoal.get',
  DAEMON_SESSION_GOAL_SET: 'daemon.sessionGoal.set',
  DAEMON_SESSION_GOAL_CLEAR: 'daemon.sessionGoal.clear',
  DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST: 'daemon.sessionVendorPluginCatalog.list',
  DAEMON_SESSION_SKILL_CATALOG_LIST: 'daemon.sessionSkillCatalog.list',
  DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE: 'daemon.sessionUsageLimit.waitResume.enable',
  DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL: 'daemon.sessionUsageLimit.waitResume.cancel',
  DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW: 'daemon.sessionUsageLimit.checkNow',
  DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME: 'daemon.connectedServiceQuota.recoveryCredit.consume',
  DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH: 'daemon.sessionConnectedServiceAuth.switch',
  DAEMON_SESSION_RUNNER_STATUS_GET: 'daemon.sessionRunner.status.get',
  DAEMON_SESSION_RUNNER_RESTART: 'daemon.sessionRunner.restart',
  DAEMON_SESSION_RUNNER_RESTART_ALL: 'daemon.sessionRunner.restartAll',
  DAEMON_SESSION_HANDOFF_START: 'daemon.sessionHandoff.start',
  DAEMON_SESSION_HANDOFF_PREPARE_TARGET: 'daemon.sessionHandoff.prepareTarget',
  DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET: 'daemon.sessionHandoff.prepareTargetResult.get',
  DAEMON_SESSION_HANDOFF_COMMIT: 'daemon.sessionHandoff.commit',
  DAEMON_SESSION_HANDOFF_ABORT: 'daemon.sessionHandoff.abort',
  DAEMON_SESSION_HANDOFF_STATUS_GET: 'daemon.sessionHandoff.status.get',
  DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET: 'daemon.sessionHandoff.capability.v2.get',
  DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2: 'daemon.sessionHandoff.prepareTarget.v2',
  DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2: 'daemon.sessionHandoff.prepareTargetResult.get.v2',
  DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2: 'daemon.sessionHandoff.targetResume.v2',
  DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2: 'daemon.sessionHandoff.targetConfirm.v2',
  DAEMON_SESSION_HANDOFF_COMMIT_V2: 'daemon.sessionHandoff.commit.v2',
  DAEMON_SESSION_HANDOFF_ABORT_V2: 'daemon.sessionHandoff.abort.v2',
  SESSION_CONTINUE_WITH_REPLAY: 'session.continueWithReplay',
  SESSION_FORK: 'session.fork',
  /**
   * Same-Session cross-Agent continuation. Owned by the DAEMON machine RPC, not
   * the session-process registrar: the operation stops the very runtime that
   * would otherwise be handling it, so the session process cannot be its own
   * coordinator.
   */
  SESSION_AGENT_TRANSITION: 'session.agentTransition',
  /**
   * Read-only live eligibility probe for an in-place transition. Grants no
   * authority and persists nothing; the mutation revalidates every fact.
   */
  SESSION_CONTINUATION_INSPECT: 'session.continuation.inspect',
  /**
   * Read-only rebuild of the activation brief one transition divider stands
   * for. Runs the same bounded context pass the transition ran, bounded by the
   * divider's recorded cutoff.
   */
  SESSION_AGENT_TRANSITION_BRIEF_PREVIEW: 'session.agentTransition.briefPreview',
  BASH: 'bash',
  PREVIEW_ENV: 'preview-env',
  READ_FILE: 'readFile',
  WRITE_FILE: 'writeFile',
  CREATE_DIRECTORY: 'createDirectory',
  LIST_DIRECTORY: 'listDirectory',
  GET_DIRECTORY_TREE: 'getDirectoryTree',
  DAEMON_FILESYSTEM_LIST_ROOTS: 'daemon.filesystem.listRoots',
  DAEMON_FILESYSTEM_LIST_DIRECTORY: 'daemon.filesystem.listDirectory',
  STAT_FILE: 'statFile',
  RENAME_PATH: 'renamePath',
  DELETE_PATH: 'deletePath',
  RIPGREP: 'ripgrep',
  DIFFTASTIC: 'difftastic',
  SESSION_LOG_TAIL: 'session.log.tail',
  SCM_BACKEND_DESCRIBE: 'scm.backend.describe',
  SCM_STATUS_SNAPSHOT: 'scm.status.snapshot',
  SCM_DIFF_FILE: 'scm.diff.file',
  SCM_DIFF_COMMIT: 'scm.diff.commit',
  SCM_CHANGE_INCLUDE: 'scm.change.include',
  SCM_CHANGE_EXCLUDE: 'scm.change.exclude',
  SCM_CHANGE_DISCARD: 'scm.change.discard',
  SCM_COMMIT_CREATE: 'scm.commit.create',
  SCM_COMMIT_BACKOUT: 'scm.commit.backout',
  SCM_LOG_LIST: 'scm.log.list',
  SCM_BRANCH_LIST: 'scm.branch.list',
  SCM_BRANCH_CREATE: 'scm.branch.create',
  SCM_BRANCH_CHECKOUT: 'scm.branch.checkout',
  SCM_BRANCH_MERGE: 'scm.branch.merge',
  SCM_BRANCH_REBASE: 'scm.branch.rebase',
  SCM_BRANCH_OPERATION_CONTINUE: 'scm.branch.operation.continue',
  SCM_BRANCH_OPERATION_ABORT: 'scm.branch.operation.abort',
  SCM_WORKTREE_CREATE: 'scm.worktree.create',
  SCM_WORKTREE_REMOVE: 'scm.worktree.remove',
  SCM_WORKTREE_PRUNE: 'scm.worktree.prune',
  SCM_WORKTREES_ENRICHMENT: 'scm.worktrees.enrichment',
  SCM_REMOTE_ADD: 'scm.remote.add',
  SCM_REMOTE_SET_URL: 'scm.remote.setUrl',
  SCM_REMOTE_REMOVE: 'scm.remote.remove',
  SCM_REMOTE_FETCH: 'scm.remote.fetch',
  SCM_REMOTE_PUSH: 'scm.remote.push',
  SCM_REMOTE_PULL: 'scm.remote.pull',
  SCM_REMOTE_PUBLISH: 'scm.remote.publish',
  SCM_REPOSITORY_INIT: 'scm.repository.init',
  SCM_REPOSITORY_REMOVE_INDEX_LOCK: 'scm.repository.removeIndexLock',
  SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS: 'scm.hostingRepository.describePublishTargets',
  SCM_HOSTING_REPOSITORY_PUBLISH: 'scm.hostingRepository.publish',
  SCM_STASH_LIST: 'scm.stash.list',
  SCM_STASH_DROP: 'scm.stash.drop',
  SCM_STASH_POP: 'scm.stash.pop',
  SCM_STASH_APPLY: 'scm.stash.apply',
  SCM_STASH_SHOW: 'scm.stash.show',
  SCM_PULL_REQUEST_LIST: 'scm.pullRequest.list',
  SCM_PULL_REQUEST_GET: 'scm.pullRequest.get',
  SCM_PULL_REQUEST_OPEN_OR_REUSE: 'scm.pullRequest.openOrReuse',
  SCM_PULL_REQUEST_OPEN_COMPOSE: 'scm.pullRequest.openCompose',
  SCM_PULL_REQUEST_CHECKOUT: 'scm.pullRequest.checkout',
  SCM_PULL_REQUEST_PREPARE_WORKTREE: 'scm.pullRequest.prepareWorktree',
  SCM_PULL_REQUEST_RUN_STACKED: 'scm.pullRequest.runStacked',
  KILL_SESSION: 'killSession',
  CAPABILITIES_DESCRIBE: 'capabilities.describe',
  CAPABILITIES_DETECT: 'capabilities.detect',
  CAPABILITIES_INVOKE: 'capabilities.invoke',
  BUGREPORT_COLLECT_DIAGNOSTICS: 'bugreport.collectDiagnostics',
  BUGREPORT_GET_LOG_TAIL: 'bugreport.getLogTail',
  BUGREPORT_UPLOAD_ARTIFACT: 'bugreport.uploadArtifact',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export const SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS = {
  SESSION_WRITE: 'session.write',
} as const;

export type SocketRpcAuthorizationContextKind =
  (typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS)[keyof typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS];

export type SocketRpcSessionWriteAuthorizationContext = Readonly<{
  kind: typeof SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE;
  sessionId: string;
}>;

export type SocketRpcAuthorizationContext = SocketRpcSessionWriteAuthorizationContext;

const MAX_SOCKET_RPC_AUTHORIZATION_SESSION_ID_LENGTH = 512;

const SOCKET_RPC_SESSION_WRITE_AUTHORIZATION_METHODS = new Set<string>([
  RPC_METHODS.STOP_SESSION,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
  RPC_METHODS.SESSION_AGENT_TRANSITION,
]);

const SOCKET_RPC_PROVIDER_STARTING_METHODS = new Set<string>([
  RPC_METHODS.SPAWN_HAPPY_SESSION,
  RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
  RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
  RPC_METHODS.SESSION_FORK,
  RPC_METHODS.SESSION_AGENT_TRANSITION,
  RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
  RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
  RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
  RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
  RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER,
  RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST,
]);

function normalizeSocketRpcSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_SOCKET_RPC_AUTHORIZATION_SESSION_ID_LENGTH) return null;
  return trimmed;
}

export function parseSocketRpcAuthorizationContext(value: unknown): SocketRpcAuthorizationContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE) return null;
  const sessionId = normalizeSocketRpcSessionId(record.sessionId);
  if (!sessionId) return null;
  return {
    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
    sessionId,
  };
}

export function resolveSocketRpcSessionWriteAuthorizationMethod(method: string): string | null {
  const trimmed = method.trim();
  if (SOCKET_RPC_SESSION_WRITE_AUTHORIZATION_METHODS.has(trimmed)) return trimmed;

  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return null;
  const unprefixedMethod = trimmed.slice(separatorIndex + 1);
  return SOCKET_RPC_SESSION_WRITE_AUTHORIZATION_METHODS.has(unprefixedMethod)
    ? unprefixedMethod
    : null;
}

export function resolveSocketRpcProviderStartingMethod(method: string): string | null {
  const trimmed = method.trim();
  if (SOCKET_RPC_PROVIDER_STARTING_METHODS.has(trimmed)) return trimmed;

  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return null;
  const unprefixedMethod = trimmed.slice(separatorIndex + 1);
  return SOCKET_RPC_PROVIDER_STARTING_METHODS.has(unprefixedMethod)
    ? unprefixedMethod
    : null;
}

export const RPC_ERROR_CODES = {
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
  FORBIDDEN: 'RPC_FORBIDDEN',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'RPC_SESSION_MACHINE_CONTROL_UNAVAILABLE',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export const RPC_ERROR_MESSAGES = {
  METHOD_NOT_AVAILABLE: 'RPC method not available',
  METHOD_NOT_FOUND: 'Method not found',
  FORBIDDEN: 'Forbidden',
  SESSION_MACHINE_CONTROL_UNAVAILABLE: 'Session machine control unavailable',
} as const;

// Session-scoped RPC method names (used with `${sessionId}:${method}` over socket RPC).
export const SESSION_RPC_METHODS = {
  SESSION_PERMISSION_RESPOND_LEGACY: 'permission',
  SESSION_STRUCTURED_QUESTION_RESPOND_V1: 'session.structuredQuestion.respond.v1',
  SESSION_USER_MESSAGE_SEND: 'session.userMessage.send',
  SESSION_PENDING_QUEUE_MATERIALIZE_NEXT: 'session.pendingQueue.materializeNext',
  SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1: 'session.pendingQueue.wakeCapability.v1.get',
  SESSION_PENDING_QUEUE_WAKE_V1: 'session.pendingQueue.wake.v1',
  SESSION_WORK_STATE_GET: 'session.workState.get',
  SESSION_GOAL_GET: 'session.goal.get',
  SESSION_GOAL_SET: 'session.goal.set',
  SESSION_GOAL_CLEAR: 'session.goal.clear',
  SESSION_TERMINAL_COMPOSER_CLEAR: 'session.terminalComposer.clear',
  SESSION_PENDING_INPUT_INTERRUPT_AND_RUN: 'session.pendingInput.interruptAndRun',
  SESSION_REVIEW_START_INLINE: 'session.review.startInline',
  SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS: 'session.connectedServiceAuth.invalidateTransports',
  SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION: 'session.connectedServiceAuth.applyGeneration',
  SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY: 'session.connectedServiceAuth.readRuntimeIdentity',
  SESSION_VENDOR_PLUGIN_CATALOG_LIST: 'session.vendorPluginCatalog.list',
  SESSION_SKILL_CATALOG_LIST: 'session.skillCatalog.list',
  SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE: 'session.usageLimit.waitResume.enable',
  SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL: 'session.usageLimit.waitResume.cancel',
  SESSION_USAGE_LIMIT_CHECK_NOW: 'session.usageLimit.checkNow',
  EXECUTION_RUN_START: 'execution.run.start',
  EXECUTION_RUN_ENSURE: 'execution.run.ensure',
  EXECUTION_RUN_ENSURE_OR_START: 'execution.run.ensureOrStart',
  EXECUTION_RUN_SEND: 'execution.run.send',
  EXECUTION_RUN_STREAM_START: 'execution.run.stream.start',
  EXECUTION_RUN_STREAM_START_V2: 'execution.run.stream.start.v2',
  EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1: 'execution.run.userTranscript.commit.v1',
  EXECUTION_RUN_STREAM_READ: 'execution.run.stream.read',
  EXECUTION_RUN_STREAM_CANCEL: 'execution.run.stream.cancel',
  EXECUTION_RUN_STOP: 'execution.run.stop',
  EXECUTION_RUN_LIST: 'execution.run.list',
  EXECUTION_RUN_GET: 'execution.run.get',
  EXECUTION_RUN_ACTION: 'execution.run.action',
  SESSION_ROLLBACK: 'session.rollback',
  EPHEMERAL_TASK_RUN: 'ephemeral.task.run',
} as const;

export function isDelegatedSessionApprovalRpcMethod(methodSuffix: string): boolean {
  return methodSuffix === SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY
    || methodSuffix === SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1;
}

export function isRpcMethodNotFoundResult(value: unknown): value is { error: string; errorCode?: string } {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as any;
  if (maybe.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) return true;
  return maybe.error === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND;
}
