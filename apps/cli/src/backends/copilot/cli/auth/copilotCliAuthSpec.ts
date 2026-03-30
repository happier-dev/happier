import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { resolveCommonApiKeyStatus, runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec } from '@/backends/types';

const DEFAULT_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS = 1_500;

function resolveCopilotCliAuthProbeTimeoutMs(): number {
  const raw = process.env.HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS;
  const normalized = typeof raw === 'string' ? raw.replaceAll('_', '').trim() : '';
  const parsed = normalized ? Number(normalized) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS;
}

async function readGhAuthTokenStatus(): Promise<Readonly<{
  ok: boolean;
  exitCode: number | null;
}>> {
  const result = await runCliCommandBestEffort({
    resolvedPath: 'gh',
    args: ['auth', 'token'],
    timeoutMs: resolveCopilotCliAuthProbeTimeoutMs(),
  });
  const token = `${result.stdout}\n${result.stderr}`.trim();
  return {
    ok: result.ok && token.length > 0,
    exitCode: result.exitCode,
  };
}

export const copilotCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('copilot', {
  detectAuthStatus: async () => {
    const envStatus = resolveCommonApiKeyStatus(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
    if (envStatus.state === 'logged_in') {
      return envStatus;
    }

    const ghAuth = await readGhAuthTokenStatus();
    if (ghAuth.ok) {
      return {
        state: 'logged_in',
        method: 'oauth_cli',
        source: 'command',
      };
    }
    if (typeof ghAuth.exitCode === 'number') {
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
  },
});
