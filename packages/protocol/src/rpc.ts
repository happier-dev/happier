export const RPC_METHODS = {
  SPAWN_HAPPY_SESSION: 'spawn-happy-session',
  STOP_SESSION: 'stop-session',
  STOP_DAEMON: 'stop-daemon',
  DAEMON_EXECUTION_RUNS_LIST: 'daemon.executionRuns.list',
  DAEMON_MEMORY_SEARCH: 'daemon.memory.search',
  DAEMON_MEMORY_GET_WINDOW: 'daemon.memory.getWindow',
  DAEMON_MEMORY_ENSURE_UP_TO_DATE: 'daemon.memory.ensureUpToDate',
  DAEMON_MEMORY_STATUS: 'daemon.memory.status',
  DAEMON_MEMORY_SETTINGS_GET: 'daemon.memory.settings.get',
  DAEMON_MEMORY_SETTINGS_SET: 'daemon.memory.settings.set',
  SESSION_CONTINUE_WITH_REPLAY: 'session.continueWithReplay',
  BASH: 'bash',
  PREVIEW_ENV: 'preview-env',
  READ_FILE: 'readFile',
  WRITE_FILE: 'writeFile',
  LIST_DIRECTORY: 'listDirectory',
  GET_DIRECTORY_TREE: 'getDirectoryTree',
  RIPGREP: 'ripgrep',
  DIFFTASTIC: 'difftastic',
  SCM_BACKEND_DESCRIBE: 'scm.backend.describe',
  SCM_STATUS_SNAPSHOT: 'scm.status.snapshot',
  SCM_DIFF_FILE: 'scm.diff.file',
  SCM_DIFF_COMMIT: 'scm.diff.commit',
  SCM_CHANGE_INCLUDE: 'scm.change.include',
  SCM_CHANGE_EXCLUDE: 'scm.change.exclude',
  SCM_COMMIT_CREATE: 'scm.commit.create',
  SCM_COMMIT_BACKOUT: 'scm.commit.backout',
  SCM_LOG_LIST: 'scm.log.list',
  SCM_REMOTE_FETCH: 'scm.remote.fetch',
  SCM_REMOTE_PUSH: 'scm.remote.push',
  SCM_REMOTE_PULL: 'scm.remote.pull',
  KILL_SESSION: 'killSession',
  CAPABILITIES_DESCRIBE: 'capabilities.describe',
  CAPABILITIES_DETECT: 'capabilities.detect',
  CAPABILITIES_INVOKE: 'capabilities.invoke',
  BUGREPORT_COLLECT_DIAGNOSTICS: 'bugreport.collectDiagnostics',
  BUGREPORT_GET_LOG_TAIL: 'bugreport.getLogTail',
  BUGREPORT_UPLOAD_ARTIFACT: 'bugreport.uploadArtifact',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export const RPC_ERROR_CODES = {
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export const RPC_ERROR_MESSAGES = {
  METHOD_NOT_AVAILABLE: 'RPC method not available',
  METHOD_NOT_FOUND: 'Method not found',
} as const;

// Session-scoped RPC method names (used with `${sessionId}:${method}` over socket RPC).
export const SESSION_RPC_METHODS = {
  EXECUTION_RUN_START: 'execution.run.start',
  EXECUTION_RUN_ENSURE: 'execution.run.ensure',
  EXECUTION_RUN_ENSURE_OR_START: 'execution.run.ensureOrStart',
  EXECUTION_RUN_SEND: 'execution.run.send',
  EXECUTION_RUN_STREAM_START: 'execution.run.stream.start',
  EXECUTION_RUN_STREAM_READ: 'execution.run.stream.read',
  EXECUTION_RUN_STREAM_CANCEL: 'execution.run.stream.cancel',
  EXECUTION_RUN_STOP: 'execution.run.stop',
  EXECUTION_RUN_LIST: 'execution.run.list',
  EXECUTION_RUN_GET: 'execution.run.get',
  EXECUTION_RUN_ACTION: 'execution.run.action',
  EPHEMERAL_TASK_RUN: 'ephemeral.task.run',
} as const;

export function isRpcMethodNotFoundResult(value: unknown): value is { error: string; errorCode?: string } {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as any;
  if (maybe.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) return true;
  return maybe.error === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND;
}
