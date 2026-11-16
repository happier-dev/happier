import { isSessionHappierToolsEnabled } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1'
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer'
import { resolveAgentSessionHolderExecutablePath } from '@/subprocess/supervision/sessionHolder'
import { readSessionTargetPlacement, resolveSessionAgentMcpContextFile } from '@/subprocess/supervision/sessionTargetRelay'
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope'
import type { McpServerConfig } from '@/agent'
import type { StoredCredentials } from '@/persistence'
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider'
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller'
import { SESSION_MCP_CONTEXT_FILE_ENV, SessionMcpUnavailableError, supportsSessionMcpLocalTransport, type SessionMcpLocalContext, type SessionMcpLocalTransportOptions } from '@/mcp/runtime/sessionMcpLocalTransport'
import { SESSION_MCP_BEARER_ENV, SESSION_MCP_REGISTRATION_ENV, sessionMcpRegistrationId } from '@/mcp/runtime/sessionMcpLocalContext'
import type { SessionMcpCustomToolsBridge } from '@/mcp/runtime/sessionMcpToolsBridge'
import type {
  AccountSettings,
  ActionId,
  ActionExecutorDeps,
  SessionRunPromptReadActionIdV1,
} from '@happier-dev/protocol'

/**
 * Every Session MCP registration has a private context (socket or Windows loopback + bearer). Agents
 * launch the native relay mode of the shipped holder, which pipes MCP stdio to the Session's
 * endpoint; this host serves every tool in-process (no per-Session bridge process). The relay
 * reads its context file path and registration bearer; it starts no tools and reads no settings.
 */
function resolveHappierMcpServerConfig(server: Readonly<{ localContext?: SessionMcpLocalContext; contextFilePath?: string }>): McpServerConfig {
  if (!server.localContext) throw new SessionMcpUnavailableError()
  // An isolated Agent's context file is placed by its launch materialization (`resolveRunnerMcpServers`).
  // The relay's bearer selects its registration when a Session and its Runs share a Unix socket;
  // Windows loopback also requires it. It rides only this MCP client config (never the context file or the Agent env).
  // In a placed Session the relay uses the context of the holder it runs under in the target, which
  // admits by that holder's own Agent-tree proof; this Machine's bearer never crosses.
  const contextFilePath = resolveSessionAgentMcpContextFile(server.contextFilePath)
  const placed = readSessionTargetPlacement(sessionProcessEnvironment()) !== null
  const relayEnvironment: Readonly<Record<string, string>> = placed ? {
    [SESSION_MCP_REGISTRATION_ENV]: sessionMcpRegistrationId(server.localContext),
  } : {
    ...(contextFilePath ? { [SESSION_MCP_CONTEXT_FILE_ENV]: contextFilePath } : {}),
    [SESSION_MCP_BEARER_ENV]: server.localContext.bearerToken,
  }
  return { command: resolveAgentSessionHolderExecutablePath(), args: ['mcp-relay'],
    ...(relayEnvironment ? { env: relayEnvironment } : {}) }
}

export async function createHappierMcpBridge(
  session: HappyMcpSessionClient,
  opts: {
    localTransport?: SessionMcpLocalTransportOptions
    sessionMetadata?: unknown
    sessionToolsBridge?: SessionMcpCustomToolsBridge
    commandMode?: 'direct-script' | 'current-process'
    mcpToolCallIdMetaKey?: string
    sessionCredentials?: StoredCredentials | null
    credentials?: StoredCredentials | null
    isCredentialCurrent?: () => boolean | Promise<boolean>
    authorityScope?: 'account' | 'session'
    sessionList?: ActionExecutorDeps['sessionList']
    accountSettings?: AccountSettings | null
    getAccountSettings?: (() => AccountSettings | null) | null
    actionsSettingsProvider?: RuntimeActionSettingsProvider
    requiredDirectActionIds?: readonly ActionId[]
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease
  } = {},
): Promise<{
  happierMcpServer: {
    url: string
    localContext?: SessionMcpLocalContext
    contextFilePath?: string
    supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[]
    readToolNames: (signal?: AbortSignal) => Promise<readonly string[]>
    stop: () => Promise<void>
  }
  mcpServers: Record<string, McpServerConfig>
}> {
  return createHappierMcpBridgeWithOptions(session, opts)
}

export async function createHappierMcpBridgeWithOptions(
  session: HappyMcpSessionClient,
  opts: {
    localTransport?: SessionMcpLocalTransportOptions
    sessionMetadata?: unknown
    sessionToolsBridge?: SessionMcpCustomToolsBridge
    commandMode?: 'direct-script' | 'current-process'
    mcpToolCallIdMetaKey?: string
    sessionCredentials?: StoredCredentials | null
    credentials?: StoredCredentials | null
    isCredentialCurrent?: () => boolean | Promise<boolean>
    authorityScope?: 'account' | 'session'
    sessionList?: ActionExecutorDeps['sessionList']
    accountSettings?: AccountSettings | null
    getAccountSettings?: (() => AccountSettings | null) | null
    actionsSettingsProvider?: RuntimeActionSettingsProvider
    requiredDirectActionIds?: readonly ActionId[]
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease
  } = {},
): Promise<{
  happierMcpServer: {
    url: string
    localContext?: SessionMcpLocalContext
    contextFilePath?: string
    supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[]
    readToolNames: (signal?: AbortSignal) => Promise<readonly string[]>
    stop: () => Promise<void>
  }
  mcpServers: Record<string, McpServerConfig>
}> {
  const happierToolsEnabled = isSessionHappierToolsEnabled(opts.sessionMetadata ?? session.getMetadataSnapshot?.())
  if (!happierToolsEnabled && !opts.localTransport) {
    return { happierMcpServer: { url: '', supportedSessionReadActions: [],
      readToolNames: async () => [], stop: async () => {} }, mcpServers: {} }
  }
  const { startHappyServer } = await import('@/mcp/startHappyServer')
  const happierMcpServer = await startHappyServer(session, {
    happierToolsEnabled,
    ...(opts.sessionToolsBridge ? { sessionToolsBridge: opts.sessionToolsBridge } : {}),
    ...(opts.localTransport ? { localTransport: opts.localTransport }
      : supportsSessionMcpLocalTransport() && process.getuid ? { localTransport: { agentUid: process.getuid() } } : {}),
    mcpToolCallIdMetaKey: opts.mcpToolCallIdMetaKey,
    sessionCredentials: opts.sessionCredentials ?? opts.credentials ?? null,
    credentials: opts.credentials ?? null,
    isCredentialCurrent: opts.isCredentialCurrent,
    authorityScope: opts.authorityScope ?? 'account',
    ...(opts.sessionList ? { sessionList: opts.sessionList } : {}),
    accountSettings: opts.accountSettings ?? null,
    getAccountSettings: opts.getAccountSettings ?? null,
    ...(opts.actionsSettingsProvider
      ? { actionsSettingsProvider: opts.actionsSettingsProvider }
      : {}),
    ...(opts.requiredDirectActionIds
      ? { requiredDirectActionIds: opts.requiredDirectActionIds }
      : {}),
    ...(opts.pluginRuntimeRegistryLease
      ? { pluginRuntimeRegistryLease: opts.pluginRuntimeRegistryLease }
      : {}),
  })
  let mcpServers: Record<string, McpServerConfig>
  try {
    mcpServers = happierToolsEnabled ? { happier: resolveHappierMcpServerConfig(happierMcpServer) } : {}
  } catch (error) {
    await happierMcpServer.stop()
    throw error
  }

  return {
    happierMcpServer,
    mcpServers,
  }
}
