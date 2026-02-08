import { shouldUseCodexMcpResumeServer } from '../localControl/localControlSupport';
import { resolveCodexMcpResumeServerCommand } from './resolveMcpResumeServer';

export type CodexMcpServerSpawn = Readonly<{ mode: 'codex-cli' | 'mcp-server'; command: string }>;

export async function resolveCodexMcpServerSpawn(opts: Readonly<{
  useCodexAcp: boolean;
  experimentalCodexResumeEnabled: boolean;
  vendorResumeId: string | null;
  localControlSupported: boolean;
}>): Promise<CodexMcpServerSpawn> {
  if (opts.useCodexAcp) {
    // ACP mode bypasses Codex MCP server selection (resume/no-resume).
    return { mode: 'codex-cli', command: 'codex' };
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
    return { mode: 'codex-cli', command: 'codex' };
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
