import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec } from '@/backends/types';

import { readCodexEnvironmentAuthState } from './readCodexEnvironmentAuthState';

const DEFAULT_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS = 6_000;

function resolveCodexCliAuthProbeTimeoutMs(): number {
  const raw = process.env.HAPPIER_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS;
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_CODEX_CLI_AUTH_PROBE_TIMEOUT_MS;
}

export const codexCliAuthSpec = createCatalogCliAuthSpec('codex', {
  detectAuthStatus: async ({ resolvedPath }) => {
    const environmentAuth = readCodexEnvironmentAuthState();
    const commandStatus = await runCliCommandBestEffort({
      resolvedPath,
      args: ['login', 'status'],
      timeoutMs: resolveCodexCliAuthProbeTimeoutMs(),
    });
    if (commandStatus.ok) {
      return {
        state: 'logged_in',
        method: 'oauth_cli',
        source: 'command',
        reason: null,
        ...(environmentAuth.accountLabel ? { accountLabel: environmentAuth.accountLabel } : {}),
      };
    }

    if (environmentAuth.method === 'api_key_env') {
      return {
        state: 'logged_in',
        method: 'api_key_env',
        source: 'env',
      };
    }

    if (commandStatus.exitCode === null && environmentAuth.method === 'credentials_file') {
      return {
        state: 'logged_in',
        method: 'credentials_file',
        source: 'file',
        ...(environmentAuth.accountLabel ? { accountLabel: environmentAuth.accountLabel } : {}),
      };
    }

    return {
      state: commandStatus.exitCode === null ? 'unknown' : 'logged_out',
      reason: commandStatus.exitCode === null ? 'probe_failed' : 'missing_credentials',
      source: commandStatus.exitCode === null ? 'command' : null,
    };
  },
}) satisfies CliAuthSpec;
