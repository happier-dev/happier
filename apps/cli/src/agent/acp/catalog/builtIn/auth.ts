import {
  getAgentAuthProbeConfig,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/agent/catalog/types';

import { createCatalogCliAuthSpec } from '../../../../capabilities/cliAuth/createCatalogCliAuthSpec';
import { createUnknownCliAuthSpec } from '../../../../capabilities/cliAuth/createUnknownCliAuthSpec';
import { resolveCommonApiKeyStatus, runCliCommandBestEffort } from '../../../../capabilities/cliAuth/shared';
import type { CliAuthSpec, CliAuthStatusDraft } from '@/agent/catalog/types';

function resolvePositiveIntegerEnvMs(raw: string | undefined, fallbackMs: number): number {
  const normalized = typeof raw === 'string' ? raw.replaceAll('_', '').trim() : '';
  const parsed = normalized.length > 0 ? Number(normalized) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallbackMs;
}

async function detectCopilotAuthStatus(config: Readonly<{ envVars?: readonly string[] }>): Promise<CliAuthStatusDraft> {
  const envStatus = resolveCommonApiKeyStatus(config.envVars ?? []);
  if (envStatus.state === 'logged_in') {
    return envStatus;
  }

  const result = await runCliCommandBestEffort({
    resolvedPath: 'gh',
    args: ['auth', 'token'],
    timeoutMs: resolvePositiveIntegerEnvMs(process.env.HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS, 1_500),
  });
  const token = `${result.stdout}\n${result.stderr}`.trim();
  if (result.ok && token.length > 0) {
    return {
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    };
  }
  if (typeof result.exitCode === 'number') {
    return {
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
    };
  }
  return {
    state: 'unknown',
    reason: 'probe_failed',
    source: 'command',
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

  if (config.parser === 'envOnly' || config.parser === 'piEnvOnly') {
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

  if (config.parser === 'copilotGhAuth') {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async () => detectCopilotAuthStatus(config),
    });
  }

  throw new Error(`No generic catalog CLI auth builder is available for '${agentId}' (${config.parser})`);
}
