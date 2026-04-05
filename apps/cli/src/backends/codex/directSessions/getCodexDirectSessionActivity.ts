import type { DirectSessionsSource } from '@happier-dev/protocol';

import { withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';

export async function getCodexDirectSessionActivity(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ lastActivityAtMs: number | null }>> {
  const env = params.env ?? process.env;
  return withCodexRolloutSessionStore(
    {
      activeServerDir: params.activeServerDir,
      env,
      key: {
        providerId: 'codex',
        source: params.source,
        remoteSessionId: params.remoteSessionId,
      },
    },
    async (store): Promise<Readonly<{ lastActivityAtMs: number | null }>> => {
      const activity = (await store.getActivity()) as Readonly<{ lastActivityAtMs: number | null }> | null;
      return {
        lastActivityAtMs: activity?.lastActivityAtMs ?? null,
      };
    },
  );
}
