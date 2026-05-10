import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import {
  canonicalizeExternalSessionsPath,
  directSourceValidationError,
  isSafeExternalSessionsConnectedServiceId,
  type DirectSourceValidationResult,
} from '@/session/external/sourceValidation';

export function resolveConfiguredCodexHome(env: NodeJS.ProcessEnv): string {
  const configuredHome =
    typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim().length > 0
      ? env.CODEX_HOME
      : join(homedir(), '.codex');
  return canonicalizeExternalSessionsPath(configuredHome);
}

export function sourceValidation(params: Readonly<{
  source: ExternalSessionsSource;
  env: NodeJS.ProcessEnv;
}>): DirectSourceValidationResult {
  const { source, env } = params;
  if (source.kind !== 'codexHome') return directSourceValidationError('provider/source mismatch');
  if (source.home === 'connectedService' && !isSafeExternalSessionsConnectedServiceId(source.connectedServiceId)) {
    return directSourceValidationError('invalid connectedServiceId');
  }
  if (source.home === 'user') {
    const requestedHomePath =
      typeof source.homePath === 'string' && source.homePath.trim().length > 0
        ? canonicalizeExternalSessionsPath(source.homePath)
        : null;
    const configuredHomePath = resolveConfiguredCodexHome(env);
    if (requestedHomePath && requestedHomePath !== configuredHomePath) {
      return directSourceValidationError('source homePath override is not allowed');
    }
    return {
      ok: true,
      source: {
        ...source,
        homePath: configuredHomePath,
      },
    };
  }
  return { ok: true, source };
}
