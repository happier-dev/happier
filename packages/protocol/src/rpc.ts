export const RPC_METHODS = {
  SPAWN_HAPPY_SESSION: 'spawn-happy-session',
  STOP_SESSION: 'stop-session',
  STOP_DAEMON: 'stop-daemon',
  BASH: 'bash',
  PREVIEW_ENV: 'preview-env',
  READ_FILE: 'readFile',
  WRITE_FILE: 'writeFile',
  LIST_DIRECTORY: 'listDirectory',
  GET_DIRECTORY_TREE: 'getDirectoryTree',
  RIPGREP: 'ripgrep',
  DIFFTASTIC: 'difftastic',
  GIT_STATUS_SNAPSHOT: 'git.status.snapshot',
  GIT_DIFF_FILE: 'git.diff.file',
  GIT_DIFF_COMMIT: 'git.diff.commit',
  GIT_STAGE_APPLY: 'git.stage.apply',
  GIT_UNSTAGE_APPLY: 'git.unstage.apply',
  GIT_COMMIT_CREATE: 'git.commit.create',
  GIT_LOG_LIST: 'git.log.list',
  GIT_COMMIT_REVERT: 'git.commit.revert',
  GIT_REMOTE_FETCH: 'git.remote.fetch',
  GIT_REMOTE_PUSH: 'git.remote.push',
  GIT_REMOTE_PULL: 'git.remote.pull',
  KILL_SESSION: 'killSession',
  CAPABILITIES_DESCRIBE: 'capabilities.describe',
  CAPABILITIES_DETECT: 'capabilities.detect',
  CAPABILITIES_INVOKE: 'capabilities.invoke',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export const RPC_ERROR_CODES = {
  METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export const RPC_ERROR_MESSAGES = {
  METHOD_NOT_FOUND: 'Method not found',
} as const;

// Session-scoped RPC method names (used with `${sessionId}:${method}` over socket RPC).
export const SESSION_RPC_METHODS = {
  VOICE_MEDIATOR_START: 'voice.mediator.start',
  VOICE_MEDIATOR_SEND_TURN: 'voice.mediator.sendTurn',
  VOICE_MEDIATOR_COMMIT: 'voice.mediator.commit',
  VOICE_MEDIATOR_STOP: 'voice.mediator.stop',
  VOICE_MEDIATOR_GET_MODELS: 'voice.mediator.getModels',
} as const;

export function isRpcMethodNotFoundResult(value: unknown): value is { error: string; errorCode?: string } {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as any;
  if (maybe.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) return true;
  return maybe.error === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND;
}
