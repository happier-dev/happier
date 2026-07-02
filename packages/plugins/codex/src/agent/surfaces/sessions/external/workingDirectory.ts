import type { ExternalSessionsSource } from '@happier-dev/protocol';

export type CodexExternalSessionWorkingDirectoryStoreKey = Readonly<{
  providerId: 'codex';
  source: ExternalSessionsSource;
  remoteSessionId: string;
}>;

export function resolveCodexExternalSessionWorkingDirectoryStoreKey(params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
}>): CodexExternalSessionWorkingDirectoryStoreKey {
  return {
    providerId: 'codex',
    source: params.source,
    remoteSessionId: params.remoteSessionId,
  };
}
