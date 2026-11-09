import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isBackendTargetDisabledByAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AccountSettings, AgentBackendInventoryItem } from '@happier-dev/protocol';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot'
import { readAgentContributionDisplayTitle } from '@/agent/catalog/agentDisplayTitle'

function buildCatalogBackendInventoryItems(
  accountSettings: AccountSettings | null,
): AgentBackendInventoryItem[] {
  const { agentDefinitionsById, catalogEntriesById } = readAgentCatalogSnapshot()
  return Object.keys(catalogEntriesById)
    .flatMap((agentId) => {
      const contribution = agentDefinitionsById.get(agentId)
      const targets = contribution?.identity ? listAgentExecutionTargetsV1(contribution.identity) : [{
        kind: 'backend',
        backendId: agentId,
        sourceKind: 'built_in',
      } as const]
      return targets.map((target) => ({
        targetKey: buildBackendTargetKeyV2(target),
        label: readAgentContributionDisplayTitle(contribution, agentId) ?? agentId,
        enabled: !isBackendTargetDisabledByAccountSettings(accountSettings, target),
        agentId,
        ...(contribution?.identity ? { identity: contribution.identity } : {}),
      }))
    })
}

export async function buildConfiguredAcpBackendInventoryItems(
  accountSettings: AccountSettings | null,
  acpCatalogSnapshot?: AcpCatalogSnapshotV1,
): Promise<AgentBackendInventoryItem[]> {
  // Optional discovery cannot withdraw built-in choices. Configured launch
  // admission still requires ready, current authority at its runtime owner.
  if (acpCatalogSnapshot?.status !== 'ready') return []
  const definitions = acpCatalogSnapshot.record.definitions
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]))
  const definitionIds = definitions.map((definition) => definition.id)
  const catalog = readAgentCatalogSnapshot()
  return [...catalog.agentDefinitionsById.values()].flatMap((contribution) => (
    contribution.identity ? listAgentExecutionTargetsV1(contribution.identity, definitionIds)
      .filter((target): target is typeof target & { definitionId: string } => target.definitionId !== undefined)
      .map((target) => {
        const backend = definitionById.get(target.definitionId)!
        return {
          targetKey: buildBackendTargetKeyV2(target),
          label: backend.title,
          ...(backend.description ? { description: backend.description } : {}),
          enabled: !isBackendTargetDisabledByAccountSettings(accountSettings, target),
          backendId: backend.id,
          agentId: contribution.id,
          identity: target.identity,
        }
      }) : []
  ))
}

export async function buildAgentBackendInventoryItems(params: Readonly<{
  limit?: number;
  includeDisabled?: boolean;
  accountSettings?: AccountSettings | null;
  acpCatalogSnapshot?: AcpCatalogSnapshotV1;
}>): Promise<AgentBackendInventoryItem[]> {
  const accountSettings = params.accountSettings ?? null
  const includeDisabled = params.includeDisabled === true
  const configuredAcpBackends = await buildConfiguredAcpBackendInventoryItems(
    accountSettings,
    params.acpCatalogSnapshot,
  )
  const items = [
    ...buildCatalogBackendInventoryItems(accountSettings),
    ...configuredAcpBackends,
  ].filter((item) => includeDisabled || item.enabled !== false)

  return items.slice(0, params.limit)
}
