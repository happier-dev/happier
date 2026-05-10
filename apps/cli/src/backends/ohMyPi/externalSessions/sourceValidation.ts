import type { ExternalSessionsSource } from '@happier-dev/protocol';

import {
  canonicalizeExternalSessionsPath,
  directSourceValidationError,
  type DirectSourceValidationResult,
} from '@/session/external/sourceValidation';

import { resolveConfiguredOhMyPiAgentDir } from './resolveOhMyPiAgentDir';

export function sourceValidation(params: Readonly<{
  source: ExternalSessionsSource;
  env: NodeJS.ProcessEnv;
}>): DirectSourceValidationResult {
  const { source, env } = params;
  if (source.kind !== 'ohMyPiAgentDir') return directSourceValidationError('provider/source mismatch');
  const requestedAgentDir =
    typeof source.agentDir === 'string' && source.agentDir.trim().length > 0
      ? canonicalizeExternalSessionsPath(source.agentDir)
      : null;
  const configuredAgentDir = resolveConfiguredOhMyPiAgentDir(env);
  if (requestedAgentDir && requestedAgentDir !== configuredAgentDir) {
    return directSourceValidationError('source agentDir override is not allowed');
  }
  return {
    ok: true,
    source: {
      ...source,
      agentDir: configuredAgentDir,
    },
  };
}
