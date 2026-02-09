import { join } from 'node:path'

import type { ApiSessionClient } from '@/api/session/sessionClient'
import { projectPath } from '@/projectPath'
import { startHappyServer } from '@/mcp/startHappyServer'
import type { McpServerConfig } from '@/agent'

export async function createHappierMcpBridge(
  session: ApiSessionClient,
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
  session: ApiSessionClient,
  opts: {
    commandMode?: 'direct-script' | 'current-process'
  } = {},
): Promise<{
  happierMcpServer: { url: string; stop: () => void }
  mcpServers: Record<string, McpServerConfig>
}> {
  const happierMcpServer = await startHappyServer(session)
  const bridgeCommand = join(projectPath(), 'bin', 'happier-mcp.mjs')
  const commandMode = opts.commandMode ?? 'direct-script'
  const mcpServers: Record<string, McpServerConfig> = {
    happier: {
      command: commandMode === 'current-process' ? process.execPath : bridgeCommand,
      args:
        commandMode === 'current-process'
          ? [bridgeCommand, '--url', happierMcpServer.url]
          : ['--url', happierMcpServer.url],
    },
  }

  return {
    happierMcpServer,
    mcpServers,
  }
}
