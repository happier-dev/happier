import { existsSync } from 'node:fs';

import { getCodexMcpResumeDepStatus } from '@/capabilities/deps/codexMcpResume';

function readCodexMcpResumeEnvOverride(): string | null {
  const v = typeof process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN === 'string'
    ? process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN.trim()
    : '';
  return v || null;
}

/**
 * Resolves the command to run for Codex MCP resume server.
 *
 * This is intentionally used by both:
 * - CLI startup gating (is local-control safe?)
 * - Codex MCP client spawn selection (codex-cli vs mcp-server)
 */
export async function resolveCodexMcpResumeServerCommand(): Promise<string | null> {
  const envOverride = readCodexMcpResumeEnvOverride();
  if (envOverride && existsSync(envOverride)) {
    return envOverride;
  }

  const dep = await getCodexMcpResumeDepStatus({ onlyIfInstalled: true });
  return dep?.binPath ?? null;
}
