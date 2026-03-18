import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

function expandHomeDirForDirectSessions(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveConfiguredClaudeConfigDir(params: Readonly<{ env: NodeJS.ProcessEnv }>): string {
  const fromEnv =
    typeof params.env.HAPPIER_CLAUDE_CONFIG_DIR === 'string' && params.env.HAPPIER_CLAUDE_CONFIG_DIR.trim().length > 0
      ? params.env.HAPPIER_CLAUDE_CONFIG_DIR.trim()
      : typeof params.env.CLAUDE_CONFIG_DIR === 'string'
        ? params.env.CLAUDE_CONFIG_DIR.trim()
        : '';

  const resolved = fromEnv || resolve(homedir(), '.claude');
  return expandHomeDirForDirectSessions(resolved) || resolve(homedir(), '.claude');
}

type DirectSourceValidationResult =
  | Readonly<{ ok: true; source: DirectSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

function err(error: string): DirectSourceValidationResult {
  return { ok: false, error };
}

function canonicalizePath(raw: string): string {
  const resolved = resolve(expandHomeDirForDirectSessions(raw));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = '';
  url.search = '';
  const normalized = url.toString().replace(/\/+$/, '');
  return normalized || raw.trim();
}

function isSafeConnectedServiceId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

export function validateDirectMachineSource(params: Readonly<{
  providerId: DirectSessionsProviderId;
  source: DirectSessionsSource;
  env: NodeJS.ProcessEnv;
}>): DirectSourceValidationResult {
  const { providerId, source, env } = params;

  switch (providerId) {
    case 'codex': {
      if (source.kind !== 'codexHome') return err('provider/source mismatch');
      if (source.home === 'connectedService' && !isSafeConnectedServiceId(source.connectedServiceId)) {
        return err('invalid connectedServiceId');
      }
      return { ok: true, source };
    }
    case 'claude': {
      if (source.kind !== 'claudeConfig') return err('provider/source mismatch');
      const requestedConfigDir = typeof source.configDir === 'string' && source.configDir.trim().length > 0 ? canonicalizePath(source.configDir) : null;
      const configuredConfigDir = canonicalizePath(resolveConfiguredClaudeConfigDir({ env }));
      if (requestedConfigDir && requestedConfigDir !== configuredConfigDir) {
        return err('source configDir override is not allowed');
      }
      return {
        ok: true,
        source: {
          ...source,
          configDir: configuredConfigDir,
        },
      };
    }
    case 'opencode': {
      if (source.kind !== 'opencodeServer') return err('provider/source mismatch');
      const requestedBaseUrl = typeof source.baseUrl === 'string' && source.baseUrl.trim().length > 0 ? normalizeUrl(source.baseUrl) : null;
      const configuredBaseUrl =
        typeof env.HAPPIER_OPENCODE_SERVER_URL === 'string' && env.HAPPIER_OPENCODE_SERVER_URL.trim().length > 0
          ? normalizeUrl(env.HAPPIER_OPENCODE_SERVER_URL)
          : null;

      if (requestedBaseUrl && !configuredBaseUrl) {
        return err('source baseUrl override is not allowed');
      }
      if (requestedBaseUrl && configuredBaseUrl && requestedBaseUrl !== configuredBaseUrl) {
        return err('source baseUrl override is not allowed');
      }

      return {
        ok: true,
        source: configuredBaseUrl
          ? {
              ...source,
              baseUrl: configuredBaseUrl,
            }
          : source,
      };
    }
  }
}
