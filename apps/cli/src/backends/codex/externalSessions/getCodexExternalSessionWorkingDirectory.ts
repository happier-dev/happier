import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';

export async function getCodexExternalSessionWorkingDirectory(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  return withCodexRolloutSessionStore(
    {
      activeServerDir: params.activeServerDir,
      env: params.env,
      key: {
        providerId: 'codex',
        source: params.source,
        remoteSessionId: params.remoteSessionId,
      },
    },
    (store) => store.getWorkingDirectory(),
  );
}
