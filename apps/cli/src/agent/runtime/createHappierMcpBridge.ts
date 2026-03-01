import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { projectPath } from '@/projectPath'
import { startHappyServer, type HappyMcpSessionClient } from '@/mcp/startHappyServer'
import type { McpServerConfig } from '@/agent'
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI'

function resolveHappierMcpServerConfig(url: string, commandMode: 'direct-script' | 'current-process'): McpServerConfig {
  const bridgeCommand = join(projectPath(), 'bin', 'happier-mcp.mjs')

  const distBridgeEntrypoint = join(projectPath(), 'dist', 'backends', 'codex', 'happyMcpStdioBridge.mjs')
  const sourceBridgeEntrypoint = join(projectPath(), 'src', 'backends', 'codex', 'happyMcpStdioBridge.ts')
  const tsxHookPath = resolveTsxImportHookPath()
  const canUseTsxFallback =
    !existsSync(distBridgeEntrypoint) &&
    existsSync(sourceBridgeEntrypoint) &&
    typeof tsxHookPath === 'string' &&
    tsxHookPath.length > 0

  if (canUseTsxFallback) {
    return {
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '--import',
        tsxHookPath,
        sourceBridgeEntrypoint,
        '--url',
        url,
      ],
      env: { TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() },
    }
  }

  if (commandMode === 'current-process') {
    return {
      command: process.execPath,
      args: [bridgeCommand, '--url', url],
    }
  }

  return {
    command: bridgeCommand,
    args: ['--url', url],
  }
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
    happier: resolveHappierMcpServerConfig(happierMcpServer.url, commandMode),
  }

  return {
    happierMcpServer,
    mcpServers,
  }
}
