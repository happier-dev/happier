import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

export type OhMyPiSourceValidationResult =
  | Readonly<{ ok: true; source: ExternalSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

function expandHomeDir(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function canonicalizeOhMyPiExternalSessionsPath(raw: string): string {
  const resolved = resolve(expandHomeDir(raw));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function resolveConfiguredOhMyPiAgentDir(env: NodeJS.ProcessEnv): string {
  const configured =
    typeof env.PI_CODING_AGENT_DIR === 'string' && env.PI_CODING_AGENT_DIR.trim().length > 0
      ? env.PI_CODING_AGENT_DIR
      : join(homedir(), '.omp', 'agent');
  return canonicalizeOhMyPiExternalSessionsPath(configured);
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
    ? canonicalizeOhMyPiExternalSessionsPath(sourceAgentDir)
    : resolveConfiguredOhMyPiAgentDir(env);
}

export function validateOhMyPiExternalSessionSource(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
}>): OhMyPiSourceValidationResult {
  const env = params.env ?? process.env;
  const { source } = params;
  if (source.kind !== 'ohMyPiAgentDir') {
    return { ok: false, error: 'provider/source mismatch' };
  }
  const requestedAgentDir =
    typeof source.agentDir === 'string' && source.agentDir.trim().length > 0
      ? canonicalizeOhMyPiExternalSessionsPath(source.agentDir)
      : null;
  const configuredAgentDir = resolveConfiguredOhMyPiAgentDir(env);
  if (requestedAgentDir && requestedAgentDir !== configuredAgentDir) {
    return { ok: false, error: 'source agentDir override is not allowed' };
  }
  return {
    ok: true,
    source: {
      ...source,
      agentDir: configuredAgentDir,
    },
  };
}
