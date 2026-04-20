import type { DirectSessionsSource } from '@happier-dev/protocol';

import {
  canonicalizeDirectSessionsPath,
  directSourceValidationError,
  type DirectSourceValidationResult,
} from '@/session/directSessions/sourceValidation';

import { resolveCanonicalConfiguredClaudeConfigDir } from './resolveClaudeConfigDir';

export function validateSource(params: Readonly<{
  source: DirectSessionsSource;
  env: NodeJS.ProcessEnv;
}>): DirectSourceValidationResult {
  const { source, env } = params;
  if (source.kind !== 'claudeConfig') return directSourceValidationError('provider/source mismatch');
  const requestedConfigDir =
    typeof source.configDir === 'string' && source.configDir.trim().length > 0
      ? canonicalizeDirectSessionsPath(source.configDir)
      : null;
  const configuredConfigDir = resolveCanonicalConfiguredClaudeConfigDir({ env });
  if (requestedConfigDir && requestedConfigDir !== configuredConfigDir) {
    return directSourceValidationError('source configDir override is not allowed');
  }
  return {
    ok: true,
    source: {
      ...source,
      configDir: configuredConfigDir,
    },
  };
}
