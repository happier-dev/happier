import type { DirectSessionCandidateV1 } from '@happier-dev/protocol';

import { candidates as listCandidates } from './candidates';

export async function findCodexDirectSessionCandidateViaAppServer(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<DirectSessionCandidateV1 | null> {
  const candidates = await listCandidates({
    codexHome: params.codexHome,
    env: params.env,
  });
  return candidates.find((candidate) => candidate.remoteSessionId === params.remoteSessionId) ?? null;
}
