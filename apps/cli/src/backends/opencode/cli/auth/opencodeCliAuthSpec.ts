import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec } from '@/backends/types';

const DEFAULT_OPENCODE_CLI_AUTH_PROBE_TIMEOUT_MS = 6_000;

function resolveOpenCodeCliAuthProbeTimeoutMs(): number {
  const raw = process.env.HAPPIER_OPENCODE_CLI_AUTH_PROBE_TIMEOUT_MS;
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_OPENCODE_CLI_AUTH_PROBE_TIMEOUT_MS;
}

function extractAccountLabel(stdout: string): string | null {
  const normalized = stdout.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const emailMatch = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch?.[0]) return emailMatch[0];
  }
  return null;
}

export const opencodeCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('opencode', {
  detectAuthStatus: async ({ resolvedPath }) => {
    const result = await runCliCommandBestEffort({
      resolvedPath,
      args: ['auth', 'list'],
      timeoutMs: resolveOpenCodeCliAuthProbeTimeoutMs(),
    });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (result.ok && combined.length > 0) {
      return {
        state: 'logged_in',
        method: 'oauth_cli',
        source: 'command',
        ...(extractAccountLabel(combined) ? { accountLabel: extractAccountLabel(combined) } : {}),
      };
    }
    return {
      state: result.exitCode === null ? 'unknown' : 'logged_out',
      reason: result.exitCode === null ? 'probe_failed' : 'missing_credentials',
      source: 'command',
    };
  },
});
