import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isBackendTargetDisabledByAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AccountSettings, AgentBackendInventoryItem } from '@happier-dev/protocol';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot'
import { readAgentContributionDisplayTitle } from '@/agent/catalog/agentDisplayTitle'
import { listConfiguredAcpBackendsFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend'

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
      const targetKey = buildBackendTargetKeyV2(contribution?.identity ? {
        kind: 'agent',
        identity: contribution.identity,
      } : {
        kind: 'backend',
        backendId: agentId,
        sourceKind: 'built_in',
      })
      return {
        targetKey,
        label: readAgentContributionDisplayTitle(contribution, agentId) ?? agentId,
        enabled: !isBackendTargetDisabledByAccountSettings(accountSettings, { kind: 'backend', backendId: agentId }),
        agentId,
        ...(contribution?.identity ? { identity: contribution.identity } : {}),
      }
    })
}

export async function buildConfiguredAcpBackendInventoryItems(
  accountSettings: AccountSettings | null,
  acpCatalogSnapshot?: AcpCatalogSnapshotV1,
): Promise<AgentBackendInventoryItem[]> {
  const configuredBackends = await listConfiguredAcpBackendsFromAccountSettings({
    settings: accountSettings ?? {},
    catalogSnapshot: acpCatalogSnapshot,
  })

  return configuredBackends.map((backend) => {
    const targetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: backend.backendId,
      configuredBackendId: backend.backendId,
      sourceKind: 'configured',
    })
    return {
      targetKey,
      label: backend.title,
      ...(backend.description ? { description: backend.description } : {}),
      enabled: !isBackendTargetDisabledByAccountSettings(accountSettings, {
        kind: 'backend', backendId: backend.backendId, configuredBackendId: backend.backendId,
      }),
      backendId: backend.backendId,
    }
  })
}

export async function buildAgentBackendInventoryItems(params: Readonly<{
  limit?: unknown;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
}>): Promise<AgentBackendInventoryItem[]> {
  const accountSettings = params.accountSettings ?? null
  const includeDisabled = params.includeDisabled === true
  const limit = normalizeLimit(params.limit)
  const configuredAcpBackends = await buildConfiguredAcpBackendInventoryItems(
    accountSettings,
    params.acpCatalogSnapshot,
  )
  const items = [
    ...buildCatalogBackendInventoryItems(accountSettings),
    ...configuredAcpBackends,
  ].filter((item) => includeDisabled || item.enabled !== false)

  return limit ? items.slice(0, limit) : items
}
