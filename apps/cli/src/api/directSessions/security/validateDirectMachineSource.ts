import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';
import { expandHomeDirPath } from '@happier-dev/cli-common/providers';

import {
  resolveConfiguredClaudeConfigDir,
} from '@/backends/claude/directSessions/resolveClaudeConfigDir';
import { resolvePiAgentDir } from '@/backends/pi/directSessions/resolvePiAgentDir';

type DirectSourceValidationResult =
  | Readonly<{ ok: true; source: DirectSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

function err(error: string): DirectSourceValidationResult {
  return { ok: false, error };
}

function canonicalizePath(raw: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolve(expandHomeDirPath(raw.trim(), env));
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
      const requestedConfigDir =
        typeof source.configDir === 'string' && source.configDir.trim().length > 0
          ? canonicalizePath(source.configDir, env)
          : null;
      const configuredConfigDir = canonicalizePath(resolveConfiguredClaudeConfigDir({ env }), env);
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
    case 'pi': {
      if (source.kind !== 'piAgentDir') return err('provider/source mismatch');
      const requestedAgentDir =
        typeof source.agentDir === 'string' && source.agentDir.trim().length > 0
          ? canonicalizePath(source.agentDir, env)
          : null;
      // The configured dir is daemon-controlled (env PI_CODING_AGENT_DIR or default ~/.pi/agent).
      // A client may omit agentDir; if supplied it must match the configured dir (path-traversal guard,
      // mirroring the claude configDir policy).
      const configuredAgentDir = canonicalizePath(resolvePiAgentDir({ source: { kind: 'piAgentDir' }, env }), env);
      if (requestedAgentDir && requestedAgentDir !== configuredAgentDir) {
        return err('source agentDir override is not allowed');
      }
      return {
        ok: true,
        source: {
          ...source,
          agentDir: configuredAgentDir,
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
    default: {
      return err('unsupported direct session provider');
    }
  }
}
