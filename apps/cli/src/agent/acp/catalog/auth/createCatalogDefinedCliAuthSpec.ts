import { getAgentAuthProbeConfig, type AgentId } from '@happier-dev/agents';

import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { createUnknownCliAuthSpec } from '@/capabilities/cliAuth/createUnknownCliAuthSpec';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
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

export function createCatalogDefinedCliAuthSpec(agentId: AgentId): CliAuthSpec {
  const config = getAgentAuthProbeConfig(agentId);

  if (config.parser === 'unknown') {
    return createUnknownCliAuthSpec(agentId);
  }

  if (config.parser === 'kiroWhoamiJson' && config.statusCommand) {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async ({ resolvedPath }) => detectKiroAuthStatus(resolvedPath, config.statusCommand ?? []),
    });
  }

  throw new Error(`No generic catalog CLI auth builder is available for '${agentId}' (${config.parser})`);
}
