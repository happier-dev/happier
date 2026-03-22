import type { DirectSessionsSource } from '@happier-dev/protocol';

import { findCodexDirectSessionCandidateViaAppServer } from '../appServer/session/findCodexDirectSessionCandidateViaAppServer';
import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';
import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';

export async function getCodexDirectSessionActivity(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ lastActivityAtMs: number | null }>> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  let maxMtimeMs: number | null = null;
  for (const home of homes) {
    const rollouts = await collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId });
    for (const file of rollouts) {
      const rawMtimeMs = file.mtimeMs;
      const mtimeMs = typeof rawMtimeMs === 'number' && Number.isFinite(rawMtimeMs) ? Math.trunc(rawMtimeMs) : null;
      if (mtimeMs == null || mtimeMs < 0) continue;
      if (maxMtimeMs == null || mtimeMs > maxMtimeMs) {
        maxMtimeMs = mtimeMs;
      }
    }

    if (maxMtimeMs != null) continue;

    try {
      const candidate = await findCodexDirectSessionCandidateViaAppServer({
        codexHome: home,
        remoteSessionId: params.remoteSessionId,
        env,
      });
      const rawUpdatedAtMs = candidate?.updatedAtMs;
      const updatedAtMs = typeof rawUpdatedAtMs === 'number' && Number.isFinite(rawUpdatedAtMs)
        ? Math.trunc(rawUpdatedAtMs)
        : null;
      if (updatedAtMs != null && updatedAtMs >= 0) {
        maxMtimeMs = updatedAtMs;
      }
    } catch {
      // Fall through when app-server metadata is unavailable.
    }
  }

  return { lastActivityAtMs: maxMtimeMs };
}
