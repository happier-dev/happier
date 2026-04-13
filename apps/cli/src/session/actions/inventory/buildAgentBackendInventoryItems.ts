import { AGENT_IDS, getProviderCliRuntimeSpec, type AgentId } from '@happier-dev/agents'
import { buildBackendTargetKey, type AccountSettings } from '@happier-dev/protocol'

import { listConfiguredAcpBackendsFromAccountSettingsOrPlugins } from '@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings'

export type ActionBackendInventoryItem = Readonly<{
  targetKey: string;
  label: string;
  enabled: boolean;
  agentId?: AgentId;
  backendId?: string;
  description?: string;
}>

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.max(1, Math.min(200, Math.floor(parsed)))
}

function isBackendEnabled(
  accountSettings: AccountSettings | null,
  targetKey: string,
): boolean {
  return accountSettings?.backendEnabledByTargetKey?.[targetKey] !== false
}

function buildBuiltInBackendInventoryItems(
  accountSettings: AccountSettings | null,
): readonly ActionBackendInventoryItem[] {
  return AGENT_IDS
    .filter((agentId) => agentId !== 'customAcp')
    .map((agentId) => {
      const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId })
      return {
        targetKey,
        label: getProviderCliRuntimeSpec(agentId).title,
        enabled: isBackendEnabled(accountSettings, targetKey),
        agentId,
      }
    })
}

async function buildConfiguredAcpBackendInventoryItems(
  accountSettings: AccountSettings | null,
  happyHomeDir?: string,
): Promise<readonly ActionBackendInventoryItem[]> {
  const configuredBackends = await listConfiguredAcpBackendsFromAccountSettingsOrPlugins({
    settings: accountSettings ?? {},
    happyHomeDir,
  })

  return configuredBackends.map((backend) => {
    const targetKey = buildBackendTargetKey({
      kind: 'configuredAcpBackend',
      backendId: backend.backendId,
    })
    return {
      targetKey,
      label: backend.title,
      ...(backend.description ? { description: backend.description } : {}),
      enabled: isBackendEnabled(accountSettings, targetKey),
      backendId: backend.backendId,
    }
  })
}

export async function buildAgentBackendInventoryItems(params: Readonly<{
  limit?: unknown;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
  happyHomeDir?: string;
}>): Promise<readonly ActionBackendInventoryItem[]> {
  const accountSettings = params.accountSettings ?? null
  const includeDisabled = params.includeDisabled === true
  const limit = normalizeLimit(params.limit)
  const configuredAcpBackends = await buildConfiguredAcpBackendInventoryItems(
    accountSettings,
    params.happyHomeDir,
  )
  const items = [
    ...buildBuiltInBackendInventoryItems(accountSettings),
    ...configuredAcpBackends,
  ].filter((item) => includeDisabled || item.enabled !== false)

  return limit ? items.slice(0, limit) : items
}
