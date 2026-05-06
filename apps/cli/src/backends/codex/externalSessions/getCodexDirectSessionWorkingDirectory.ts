import type { DirectSessionsSource } from '@happier-dev/protocol';

import { withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';

export async function getCodexDirectSessionWorkingDirectory(params: Readonly<{
  source: DirectSessionsSource;
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
