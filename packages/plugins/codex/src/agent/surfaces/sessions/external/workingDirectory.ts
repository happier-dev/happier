import type { CodexExternalSessionSource } from './models.js';

export type CodexExternalSessionWorkingDirectoryStoreKey = Readonly<{
  agentId: 'codex';
  source: CodexExternalSessionSource;
  remoteSessionId: string;
}>;

export function resolveCodexExternalSessionWorkingDirectoryStoreKey(params: Readonly<{
  source: CodexExternalSessionSource;
  remoteSessionId: string;
}>): CodexExternalSessionWorkingDirectoryStoreKey {
  return {
    agentId: 'codex',
    source: params.source,
    remoteSessionId: params.remoteSessionId,
  };
}
