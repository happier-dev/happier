import { createPluginEnablementUnavailableError } from '@/plugins/projection/registry/builtIn/enablement';
import type { ActionExecutorContext, AgentExecutionTargetV1, BackendTargetRefV2, SessionExecutionTargetV1 } from '@happier-dev/protocol';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readAgentConnectedAccountServiceKeysV1 } from '@happier-dev/protocol/teams/credentials/teamCredentialModelCatalogV1';

import { readAdmittedAgentCatalogSnapshotForRequest, readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { readDeclaredCatalogConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { readAgentNativeSandboxCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';

/** Preserve an admitted selection in the existing host routing reference. */
export function projectResolvedAgentBackendTarget(agentTarget: AgentExecutionTargetV1, agentId: string): BackendTargetRefV2 {
  return {
    kind: 'backend',
    backendId: agentId,
    ...(agentTarget.definitionId !== undefined ? { configuredBackendId: agentTarget.definitionId } : {}),
    sourceKind: 'built_in',
  };
}

/** Canonical installed-Agent projection shared by every authored Session creator. */
export function resolveSessionCreationAgentTarget(
  agentTarget: AgentExecutionTargetV1,
  catalog: Pick<ReturnType<typeof readAgentCatalogSnapshot>, 'agentDefinitionsById' | 'pluginEnablementById'> = readAgentCatalogSnapshot(),
): Readonly<{
  agentId: string;
  nativeSandboxAvailable: boolean;
  backendTarget: BackendTargetRefV2;
}> | null {
  const selectedTarget = AgentExecutionTargetV1Schema.safeParse(agentTarget);
  if (!selectedTarget.success) return null;
  const agentId = readAgentRoutingIdForContributionIdentity(
    indexAgentRoutingIdsByContributionIdentity([...catalog.agentDefinitionsById.values()]),
    selectedTarget.data.identity,
  );
  const agentContribution = agentId ? catalog.agentDefinitionsById.get(agentId) : null;
  if (!agentContribution) {
    const enablement = catalog.pluginEnablementById?.[selectedTarget.data.identity.pluginId];
    if (enablement?.enabled === false) {
      throw createPluginEnablementUnavailableError(enablement);
    }
    return null;
  }

  return {
    agentId: agentContribution.id,
    nativeSandboxAvailable: readAgentNativeSandboxCapabilities(agentContribution.richDefinition?.definition)?.off === true,
    backendTarget: projectResolvedAgentBackendTarget(selectedTarget.data, agentContribution.id),
  };
}

export type ReadMachineAgentProjection = (target: SessionExecutionTargetV1, context: ActionExecutorContext) =>
  Promise<PluginProjectionV2 | null>;

/** The receiving daemon owns admission. Standalone preparation can read its published Agent declarations. */
export async function readSessionCreationAgentTarget(input: Readonly<{
  agentTarget: AgentExecutionTargetV1;
  executionTarget: SessionExecutionTargetV1;
  context: ActionExecutorContext;
  localMachineId?: string;
  readMachineAgentProjection?: ReadMachineAgentProjection;
}>): Promise<(NonNullable<ReturnType<typeof resolveSessionCreationAgentTarget>> & {
  connectedAccountServiceIds: readonly string[];
}) | null> {
  const { agentTarget, executionTarget, context, localMachineId, readMachineAgentProjection } = input;
  const admitted = localMachineId === executionTarget.machineId
    ? await readAdmittedAgentCatalogSnapshotForRequest() : undefined;
  if (admitted) {
    const target = resolveSessionCreationAgentTarget(agentTarget, admitted);
    return target && { ...target, connectedAccountServiceIds: readDeclaredCatalogConnectedAccountServiceIds(admitted.catalogEntriesById[target.agentId]) };
  }

  // Bundled declarations are enough to author the legacy CLI recipe. The
  // receiver still resolves the selected contribution and checks readiness.
  const bundled = getResolvedContributionRegistry();
  const bundledTarget = resolveSessionCreationAgentTarget(agentTarget, bundled);
  if (bundledTarget) return { ...bundledTarget,
    connectedAccountServiceIds: readDeclaredCatalogConnectedAccountServiceIds(bundled.catalogEntriesById[bundledTarget.agentId]) };
  if (!readMachineAgentProjection || localMachineId === executionTarget.machineId) return null;
  const projection = await readMachineAgentProjection(executionTarget, context);
  if (!projection) return null;
  const agentId = readAgentRoutingIdForContributionIdentity(
    indexAgentRoutingIdsByContributionIdentity(Object.values(projection.agentsById)), agentTarget.identity,
  );
  const declaration = agentId ? projection.agentsById[agentId] : undefined;
  if (!declaration) return null;
  return { agentId: declaration.id, backendTarget: projectResolvedAgentBackendTarget(agentTarget, declaration.id),
    nativeSandboxAvailable: declaration.capabilities?.nativeSandbox?.off === true,
    connectedAccountServiceIds: readAgentConnectedAccountServiceKeysV1(declaration.connectedAccounts ?? []) };
}
