import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

export type CodexMcpServerSpawn = Readonly<{ mode: 'codex-cli' | 'mcp-server'; command: string }>;

/**
 * Resolve the codex binary on PATH, respecting PATHEXT on Windows.
 *
 * On non-Windows platforms we can rely on Node's PATH resolution by passing
 * `codex` directly to `execFile`/`execFileSync`.
 *
 * Node.js `execFileSync('codex', ...)` does NOT try `.cmd`/`.exe` extensions,
 * so on Windows we must resolve the full filename ourselves (respecting PATHEXT).
 */
function resolveCodexOnPath(): string {
  const override = typeof process.env.HAPPIER_CODEX_PATH === 'string'
    ? process.env.HAPPIER_CODEX_PATH.trim()
    : '';
  if (override) return override;

  const isWindows = process.platform === 'win32';
  if (!isWindows) return 'codex';
  return resolveWindowsCommandOnPath('codex') ?? 'codex';
}

export async function resolveCodexMcpServerSpawn(): Promise<CodexMcpServerSpawn> {
  // MCP runs by spawning the `codex` CLI directly. (The legacy `codex-mcp-resume` fork is removed.)
  return { mode: 'codex-cli', command: resolveCodexOnPath() };
}
