import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { canonicalizeExternalSessionsPath } from '@/session/external/sourceValidation';

export function resolveConfiguredOhMyPiAgentDir(env: NodeJS.ProcessEnv): string {
  const configured =
    typeof env.PI_CODING_AGENT_DIR === 'string' && env.PI_CODING_AGENT_DIR.trim().length > 0
      ? env.PI_CODING_AGENT_DIR
      : join(homedir(), '.omp', 'agent');
  return canonicalizeExternalSessionsPath(configured);
}

export function resolveOhMyPiAgentDir(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
}>): string {
  const env = params.env ?? process.env;
  if (params.source.kind !== 'ohMyPiAgentDir') {
    throw new Error('Expected ohMyPiAgentDir source');
  }
  const sourceAgentDir =
    typeof params.source.agentDir === 'string' && params.source.agentDir.trim().length > 0
      ? params.source.agentDir
      : null;
  return sourceAgentDir
    ? canonicalizeExternalSessionsPath(sourceAgentDir)
    : resolveConfiguredOhMyPiAgentDir(env);
}
