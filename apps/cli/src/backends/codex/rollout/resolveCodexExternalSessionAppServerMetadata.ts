import {
  mapCodexExternalSessionAppServerCandidateToMetadata,
  type CodexExternalSessionAppServerMetadata,
} from '@happier-dev/plugins-codex/agent/surfaces/sessions/external/transcript';
import type { ExternalSessionCandidateV1, ExternalSessionsSource } from '@happier-dev/protocol';

import { findCodexExternalSessionCandidateViaAppServer } from '../appServer/session/findCodexExternalSessionCandidateViaAppServer';

import { homes as resolveHomes } from '@happier-dev/plugins-codex/agent/rollout/discovery/sessionsForHomes';

export async function resolveCodexExternalSessionAppServerMetadata(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<CodexExternalSessionAppServerMetadata | null> {
  const env = params.env ?? process.env;
  const homes = await resolveHomes({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  let best: CodexExternalSessionAppServerMetadata | null = null;
  for (const home of homes) {
    let candidate: ExternalSessionCandidateV1 | null = null;
    try {
      candidate = await findCodexExternalSessionCandidateViaAppServer({
        codexHome: home,
        remoteSessionId: params.remoteSessionId,
        env,
      });
    } catch {
      candidate = null;
    }
    if (!candidate) continue;

    const metadata = mapCodexExternalSessionAppServerCandidateToMetadata({ candidate });
    if (!metadata) continue;
    if (!best || metadata.updatedAtMs > best.updatedAtMs) {
      best = metadata;
    }
  }

  return best;
}
