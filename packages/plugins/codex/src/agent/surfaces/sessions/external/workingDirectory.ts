import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/sessions';

export type CodexExternalSessionWorkingDirectoryStoreKey = Readonly<{
  agentId: 'codex';
  source: ExternalSessionsSource;
  remoteSessionId: string;
}>;

export function resolveCodexExternalSessionWorkingDirectoryStoreKey(params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
}>): CodexExternalSessionWorkingDirectoryStoreKey {
  return {
    agentId: 'codex',
    source: params.source,
    remoteSessionId: params.remoteSessionId,
  };
}
