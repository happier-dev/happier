import type { DirectSessionsSource } from '@happier-dev/protocol';

import { findCodexDirectSessionCandidateViaAppServer } from '../appServer/session/findCodexDirectSessionCandidateViaAppServer';
import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';
import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';
import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';

export async function getCodexDirectSessionWorkingDirectory(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env ?? process.env,
  });

  for (const home of homes) {
    const rollouts = await collectCodexSessionRolloutFiles({
      codexHome: home,
      remoteSessionId: params.remoteSessionId,
    });
    for (const rollout of rollouts) {
      const meta = await readCodexSessionMetaFromRollout(rollout.filePath);
      const cwd = typeof meta?.cwd === 'string' ? meta.cwd.trim() : '';
      if (cwd.length > 0) return cwd;
    }

    try {
      const candidate = await findCodexDirectSessionCandidateViaAppServer({
        codexHome: home,
        remoteSessionId: params.remoteSessionId,
        env: params.env ?? process.env,
      });
      const cwd = typeof candidate?.details?.cwd === 'string' ? candidate.details.cwd.trim() : '';
      if (cwd.length > 0) return cwd;
    } catch {
      // Fall through when app-server metadata is unavailable.
    }
  }

  return null;
}
