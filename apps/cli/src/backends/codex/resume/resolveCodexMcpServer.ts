import { existsSync } from 'node:fs';
import { join, delimiter as pathDelimiter } from 'node:path';

import { shouldUseCodexMcpResumeServer } from '../localControl/localControlSupport';
import { resolveCodexMcpResumeServerCommand } from './resolveMcpResumeServer';

export type CodexMcpServerSpawn = Readonly<{ mode: 'codex-cli' | 'mcp-server'; command: string }>;

/**
 * Resolve the codex binary on PATH, respecting PATHEXT on Windows.
 *
 * Node.js `execFileSync('codex', ...)` does NOT try `.cmd`/`.exe` extensions,
 * so on Windows we must resolve the full filename ourselves.
 */
function resolveCodexOnPath(): string {
  const override = typeof process.env.HAPPIER_CODEX_PATH === 'string'
    ? process.env.HAPPIER_CODEX_PATH.trim()
    : '';
  if (override) return override;

  const pathEnv = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  const isWindows = process.platform === 'win32';
  const extensions: string[] = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .map((e: string) => e.trim())
        .filter(Boolean)
    : [''];

  for (const dir of pathEnv.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const ext of extensions) {
      const candidate = join(trimmed, isWindows ? `codex${ext}` : 'codex');
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'codex';
}

export async function resolveCodexMcpServerSpawn(opts: Readonly<{
  useCodexAcp: boolean;
  experimentalCodexResumeEnabled: boolean;
  vendorResumeId: string | null;
  localControlSupported: boolean;
}>): Promise<CodexMcpServerSpawn> {
  if (opts.useCodexAcp) {
    // ACP mode bypasses Codex MCP server selection (resume/no-resume).
    return { mode: 'codex-cli', command: resolveCodexOnPath() };
  }

  const normalizedVendorResumeId =
    typeof opts.vendorResumeId === 'string' ? opts.vendorResumeId.trim() : null;
  const hasVendorResumeId = Boolean(normalizedVendorResumeId);
  if (hasVendorResumeId && !opts.experimentalCodexResumeEnabled) {
    throw new Error('Codex resume is experimental and is disabled on this machine.');
  }

  const needsResumeServer = shouldUseCodexMcpResumeServer({
    experimentalCodexResumeEnabled: opts.experimentalCodexResumeEnabled,
    vendorResumeId: normalizedVendorResumeId,
    localControlSupported: opts.localControlSupported,
  });

  if (!needsResumeServer) {
    return { mode: 'codex-cli', command: resolveCodexOnPath() };
  }

  const command = (await resolveCodexMcpResumeServerCommand())?.trim() ?? null;
  if (!command) {
    throw new Error(
      `Codex resume MCP server is not installed.\n` +
        `Install it from the Happier app (Machine details → Codex resume), or set HAPPIER_CODEX_RESUME_MCP_SERVER_BIN.`,
    );
  }

  return { mode: 'mcp-server', command };
}
