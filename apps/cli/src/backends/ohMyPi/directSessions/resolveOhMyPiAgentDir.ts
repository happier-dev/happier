import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { canonicalizeDirectSessionsPath } from '@/session/directSessions/sourceValidation';

export function resolveConfiguredOhMyPiAgentDir(env: NodeJS.ProcessEnv): string {
  const configured =
    typeof env.PI_CODING_AGENT_DIR === 'string' && env.PI_CODING_AGENT_DIR.trim().length > 0
      ? env.PI_CODING_AGENT_DIR
      : join(homedir(), '.omp', 'agent');
  return canonicalizeDirectSessionsPath(configured);
}

export function resolveOhMyPiAgentDir(params: Readonly<{
  source: DirectSessionsSource;
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
    ? canonicalizeDirectSessionsPath(sourceAgentDir)
    : resolveConfiguredOhMyPiAgentDir(env);
}
