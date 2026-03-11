import { requireProviderCliCommand } from '@/runtime/managedTools/requireProviderCliCommand';

export type CodexMcpServerSpawn = Readonly<{ mode: 'codex-cli' | 'mcp-server'; command: string }>;

export async function resolveCodexMcpServerSpawn(): Promise<CodexMcpServerSpawn> {
  // MCP runs by spawning the `codex` CLI directly. (The legacy `codex-mcp-resume` fork is removed.)
  return { mode: 'codex-cli', command: requireProviderCliCommand('codex') };
}
