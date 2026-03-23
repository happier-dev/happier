import type { DirectSessionCandidateV1 } from '@happier-dev/protocol';

import { listCodexDirectSessionCandidatesViaAppServer } from './listCodexDirectSessionCandidatesViaAppServer';

export async function findCodexDirectSessionCandidateViaAppServer(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<DirectSessionCandidateV1 | null> {
  const candidates = await listCodexDirectSessionCandidatesViaAppServer({
    codexHome: params.codexHome,
    env: params.env,
  });
  return candidates.find((candidate) => candidate.remoteSessionId === params.remoteSessionId) ?? null;
}
