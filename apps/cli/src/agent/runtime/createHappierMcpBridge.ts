import { startHappyServer, type HappyMcpSessionClient } from '@/mcp/startHappyServer'
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand'
import type { McpServerConfig } from '@/agent'

async function resolveHappierMcpServerConfig(url: string, _commandMode: 'direct-script' | 'current-process'): Promise<McpServerConfig> {
  return await resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['backends', 'codex', 'happyMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['backends', 'codex', 'happyMcpStdioBridge.ts'],
    args: ['--url', url],
  })
}

export async function createHappierMcpBridge(
  session: HappyMcpSessionClient,
  opts: {
    commandMode?: 'direct-script' | 'current-process'
  } = {},
): Promise<{
  happierMcpServer: { url: string; stop: () => void }
  mcpServers: Record<string, McpServerConfig>
}> {
  return createHappierMcpBridgeWithOptions(session, opts)
}

export async function createHappierMcpBridgeWithOptions(
  session: HappyMcpSessionClient,
  opts: {
    commandMode?: 'direct-script' | 'current-process'
  } = {},
): Promise<{
  happierMcpServer: { url: string; stop: () => void }
  mcpServers: Record<string, McpServerConfig>
}> {
  const happierMcpServer = await startHappyServer(session)
  const commandMode = opts.commandMode ?? 'direct-script'
  const mcpServers: Record<string, McpServerConfig> = {
    happier: await resolveHappierMcpServerConfig(happierMcpServer.url, commandMode),
  }

  return {
    happierMcpServer,
    mcpServers,
  }
}
