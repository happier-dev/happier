import { startHappyServer, type HappyMcpSessionClient } from '@/mcp/startHappyServer'
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand'
import type { McpServerConfig } from '@/agent'
import type { StoredCredentials } from '@/persistence'
import type { AccountSettings, ActionsSettingsV1 } from '@happier-dev/protocol'

function isTruthyEnvFlag(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y'
}

function serializeActionSettingsForEnv(accountSettings: AccountSettings | null | undefined): string | null {
  const actionSettings = accountSettings?.actionsSettingsV1 as ActionsSettingsV1 | undefined
  if (actionSettings) {
    try {
      return JSON.stringify(actionSettings)
    } catch {
      return null
    }
  }

  const actionSettingsEnv = process.env.HAPPIER_ACTIONS_SETTINGS_V1
  return typeof actionSettingsEnv === 'string' && actionSettingsEnv.length > 0 ? actionSettingsEnv : null
}

function withActionSettingsEnv(config: McpServerConfig, accountSettings?: AccountSettings | null): McpServerConfig {
  const actionSettings = serializeActionSettingsForEnv(accountSettings)
  if (typeof actionSettings !== 'string' || actionSettings.length === 0) {
    return config
  }

  return {
    ...config,
    env: {
      ...(config.env ?? {}),
      HAPPIER_ACTIONS_SETTINGS_V1: actionSettings,
    },
  }
}

async function resolveHappierMcpServerConfig(
  url: string,
  _commandMode: 'direct-script' | 'current-process',
  accountSettings?: AccountSettings | null,
): Promise<McpServerConfig> {
  const config = await resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['mcp', 'bridges', 'happierMcpStdioBridge.ts'],
    args: ['--url', url],
    preferSourceEntrypoint: isTruthyEnvFlag(process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT),
  })
  return withActionSettingsEnv(config, accountSettings)
}

export async function createHappierMcpBridge(
  session: HappyMcpSessionClient,
  opts: {
    commandMode?: 'direct-script' | 'current-process'
    credentials?: StoredCredentials | null
    accountSettings?: AccountSettings | null
    getAccountSettings?: (() => AccountSettings | null) | null
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
    credentials?: StoredCredentials | null
    accountSettings?: AccountSettings | null
    getAccountSettings?: (() => AccountSettings | null) | null
  } = {},
): Promise<{
  happierMcpServer: { url: string; stop: () => void }
  mcpServers: Record<string, McpServerConfig>
}> {
  const happierMcpServer = await startHappyServer(session, {
    credentials: opts.credentials ?? null,
    accountSettings: opts.accountSettings ?? null,
    getAccountSettings: opts.getAccountSettings ?? null,
  })
  const commandMode = opts.commandMode ?? 'direct-script'
  const mcpServers: Record<string, McpServerConfig> = {
    happier: await resolveHappierMcpServerConfig(happierMcpServer.url, commandMode, opts.accountSettings ?? null),
  }

  return {
    happierMcpServer,
    mcpServers,
  }
}
