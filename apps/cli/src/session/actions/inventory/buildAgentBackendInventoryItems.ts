import {
  buildBackendTargetKey,
  buildBackendTargetKeyV2,
  type AccountSettings,
  type AgentBackendInventoryItem,
} from '@happier-dev/protocol'

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot'
import { readAgentContributionDisplayTitle } from '@/agent/catalog/agentDisplayTitle'
import { listConfiguredAcpBackendsFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend'

import { isBackendEnabled } from './backendAvailability'

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.max(1, Math.min(200, Math.floor(parsed)))
}

function buildCatalogBackendInventoryItems(
  accountSettings: AccountSettings | null,
): AgentBackendInventoryItem[] {
  const { agentDefinitionsById, catalogEntriesById } = readAgentCatalogSnapshot()
  return Object.keys(catalogEntriesById)
    .map((agentId) => {
      const contribution = agentDefinitionsById.get(agentId)
      const targetKey = buildBackendTargetKeyV2({
        kind: 'backend',
        backendId: agentId,
        sourceKind: 'built_in',
      })
      const legacyTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId })
      return {
        targetKey,
        label: readAgentContributionDisplayTitle(contribution, agentId) ?? agentId,
        enabled: isBackendEnabled(accountSettings, [targetKey, legacyTargetKey]),
        agentId,
        ...(contribution?.identity ? { identity: contribution.identity } : {}),
      }
    })
}

async function buildConfiguredAcpBackendInventoryItems(
  accountSettings: AccountSettings | null,
): Promise<AgentBackendInventoryItem[]> {
  const configuredBackends = await listConfiguredAcpBackendsFromAccountSettings({
    settings: accountSettings ?? {},
  })

  return configuredBackends.map((backend) => {
    const targetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: backend.backendId,
      configuredBackendId: backend.backendId,
      sourceKind: 'configured',
    })
    const legacyTargetKey = buildBackendTargetKey({
      kind: 'configuredAcpBackend',
      backendId: backend.backendId,
    })
    return {
      targetKey,
      label: backend.title,
      ...(backend.description ? { description: backend.description } : {}),
      enabled: isBackendEnabled(accountSettings, [targetKey, legacyTargetKey]),
      backendId: backend.backendId,
    }
  })
}

export async function buildAgentBackendInventoryItems(params: Readonly<{
  limit?: unknown;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
}>): Promise<AgentBackendInventoryItem[]> {
  const accountSettings = params.accountSettings ?? null
  const includeDisabled = params.includeDisabled === true
  const limit = normalizeLimit(params.limit)
  const configuredAcpBackends = await buildConfiguredAcpBackendInventoryItems(
    accountSettings,
  )
  const items = [
    ...buildCatalogBackendInventoryItems(accountSettings),
    ...configuredAcpBackends,
  ].filter((item) => includeDisabled || item.enabled !== false)

  return limit ? items.slice(0, limit) : items
}
