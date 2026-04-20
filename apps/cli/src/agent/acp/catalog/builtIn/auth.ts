import {
  getAgentAuthProbeConfig,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/backends/types';

import { createCatalogCliAuthSpec } from '../../../../capabilities/cliAuth/createCatalogCliAuthSpec';
import { createUnknownCliAuthSpec } from '../../../../capabilities/cliAuth/createUnknownCliAuthSpec';
import { resolveCommonApiKeyStatus, runCliCommandBestEffort } from '../../../../capabilities/cliAuth/shared';
import type { CliAuthSpec, CliAuthStatusDraft } from '@/backends/types';

function parseKiroWhoamiAccountLabel(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['email', 'username', 'displayName', 'name']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function detectKiroAuthStatus(resolvedPath: string, args: ReadonlyArray<string>): Promise<CliAuthStatusDraft> {
  const result = await runCliCommandBestEffort({
    resolvedPath,
    args: [...args],
    timeoutMs: 2_000,
  });

  if (!result.ok) {
    return {
      state: result.exitCode === null ? 'unknown' : 'logged_out',
      reason: result.exitCode === null ? 'probe_failed' : 'missing_credentials',
      source: 'command',
    };
  }

  const accountLabel = parseKiroWhoamiAccountLabel(result.stdout);

  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
    ...(accountLabel ? { accountLabel } : {}),
  };
}

function parseOpenCodeAuthListAccountLabel(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const tokens = line.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    for (const token of tokens) {
      // Heuristic: first email-like token.
      if (token.includes('@') && token.includes('.')) {
        return token;
      }
    }
  }
  return null;
}

async function detectOpenCodeAuthStatus(resolvedPath: string, args: ReadonlyArray<string>): Promise<CliAuthStatusDraft> {
  const result = await runCliCommandBestEffort({
    resolvedPath,
    args: [...args],
    timeoutMs: 2_000,
  });

  if (!result.ok) {
    return {
      state: result.exitCode === null ? 'unknown' : 'logged_out',
      reason: result.exitCode === null ? 'probe_failed' : 'missing_credentials',
      source: 'command',
    };
  }

  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
  }

  const accountLabel = parseOpenCodeAuthListAccountLabel(trimmed);
  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
    ...(accountLabel ? { accountLabel } : {}),
  };
}

export function createBuiltInCliAuthSpec(agentId: CatalogAgentLookupId): CliAuthSpec {
  const config = isAgentId(agentId)
    ? getAgentAuthProbeConfig(agentId)
    : legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)
      ? legacyCustomAcpCompat.getLegacyCustomAcpAgentAuthProbeConfig()
      : null;
  if (!config) {
    throw new Error(`Unsupported built-in CLI auth lookup id '${agentId}'`);
  }

  if (config.parser === 'unknown') {
    return createUnknownCliAuthSpec(agentId);
  }

  if (config.parser === 'kiroWhoamiJson' && config.statusCommand) {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async ({ resolvedPath }) => detectKiroAuthStatus(resolvedPath, config.statusCommand ?? []),
    });
  }

  if (config.parser === 'opencodeAuthList' && config.statusCommand) {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async ({ resolvedPath }) => detectOpenCodeAuthStatus(resolvedPath, config.statusCommand ?? []),
    });
  }

  if (config.parser === 'piEnvOnly') {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async () => {
        const envStatus = resolveCommonApiKeyStatus(config.envVars ?? []);
        if (envStatus.state === 'logged_in') {
          return envStatus;
        }

        return {
          state: 'logged_out',
          reason: 'missing_credentials',
        };
      },
    });
  }

  throw new Error(`No generic catalog CLI auth builder is available for '${agentId}' (${config.parser})`);
}
