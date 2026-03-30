import { startHappyServer, type HappyMcpSessionClient } from '@/mcp/startHappyServer'
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand'
import type { McpServerConfig } from '@/agent'
import type { Credentials } from '@/persistence'

function isTruthyEnvFlag(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y'
}

async function resolveHappierMcpServerConfig(url: string, _commandMode: 'direct-script' | 'current-process'): Promise<McpServerConfig> {
  return await resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['backends', 'codex', 'happyMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['backends', 'codex', 'happyMcpStdioBridge.ts'],
    args: ['--url', url],
    preferSourceEntrypoint: isTruthyEnvFlag(process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT),
  })
}

export async function createHappierMcpBridge(
  session: HappyMcpSessionClient,
  opts: {
    commandMode?: 'direct-script' | 'current-process'
    credentials?: Credentials | null
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
    credentials?: Credentials | null
  } = {},
): Promise<{
  happierMcpServer: { url: string; stop: () => void }
  mcpServers: Record<string, McpServerConfig>
}> {
  const happierMcpServer = await startHappyServer(session, {
    credentials: opts.credentials ?? null,
  })
  const commandMode = opts.commandMode ?? 'direct-script'
  const mcpServers: Record<string, McpServerConfig> = {
    happier: await resolveHappierMcpServerConfig(happierMcpServer.url, commandMode),
  }

  return {
    happierMcpServer,
    mcpServers,
  }
}
