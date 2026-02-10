import { applyClaudeRemoteMetaState, DEFAULT_CLAUDE_REMOTE_META_STATE } from './claudeRemoteMetaState';

export function resolveInitialClaudeRemoteMetaState(params: Readonly<{
  metaDefaults?: Record<string, unknown> | null;
}>): typeof DEFAULT_CLAUDE_REMOTE_META_STATE {
  return applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, params.metaDefaults ?? {});
}

