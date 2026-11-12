import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { resolveOperationalBackendTargetForAgentSelection } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import type { VoiceReadinessFact, VoiceRoleReadiness } from '@/voice/registry/readiness';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveVoiceAttemptRecoveryRuntimeTarget } from '@/voice/agent/voiceAgentRecoveryTarget';
import { projectMachineAgentForCredential } from '@/agents/machineAgents/machineAgentModel';
import { resolveSelectedProviderRoute } from '@/providers/session/resolveSelectedProviderRoute';

/** Passive selection uses the same remembered/catalog facts that Start admits. */
export function projectVoiceDefaultAgentSelection(
    params: Omit<Parameters<typeof resolvePreferredBackendTarget>[0], 'machineAgents'> & { machineAgents?: undefined },
): Readonly<{ backendTarget: BackendTargetRefV2; agentTarget: AgentExecutionTargetV1 | null }> {
    const preferred = resolvePreferredBackendTarget(params);
    const backendTarget = resolveOperationalBackendTargetForAgentSelection({
        backendTarget: preferred,
        mergedProviderProjectionById: params.daemonMergedProjectionInputs?.mergedProviderProjectionById,
    }) ?? { kind: 'backend' as const, backendId: preferred.kind === 'agent'
        ? buildQualifiedPluginContributionKey(preferred.identity) : preferred.backendId };
    return { backendTarget, agentTarget: resolveAgentExecutionTargetForBackendTarget({
        backendTarget, daemonMergedProjectionInputs: params.daemonMergedProjectionInputs,
    }) };
}

/** Inventory owns authentication and installation; catalog presence alone is not readiness. */
export function projectVoiceSelectedAgentReadiness(
    target: AgentExecutionTargetV1 | null,
    inventory: MachineAgentsSnapshot,
    context: Readonly<{ serverId: string | null | undefined; machineId: string | null | undefined;
        modelRoute?: Parameters<typeof resolveSelectedProviderRoute>[0] }>,
): Readonly<{ runtime: VoiceReadinessFact; selectedAgent?: VoiceRoleReadiness['selectedAgent'] }> {
    if (!target) return { runtime: 'unknown' };
    const bundledId = resolveBundledAgentIdFromContributionIdentity(target.identity);
    const agentId = bundledId ?? buildQualifiedPluginContributionKey(target.identity);
    const row = inventory.agents.find(agent => agent.agentId === agentId && agent.definitionId === target.definitionId);
    const observed = inventory.status === 'idle' || inventory.status === 'offline' || inventory.status === 'error'
        || row?.stale ? undefined : row;
    const providerRoute = context.modelRoute ? resolveSelectedProviderRoute(context.modelRoute) : null;
    const agent = providerRoute ? projectMachineAgentForCredential(observed, { credentialBindings: null, providerRoute }) : observed;
    const runtime: VoiceReadinessFact = agent?.state === 'ready' || agent?.state === 'updateAvailable' ? 'ready'
        : agent?.state === 'needsSignIn' || agent?.state === 'notInstalled' ? 'missing'
            : agent?.state === 'installing' ? 'installing' : agent?.state === 'unsupported' ? 'incompatible' : 'unknown';
    return { runtime, selectedAgent: {
        title: row?.title ?? (bundledId ? resolveAgentCatalogTitle(bundledId) : target.identity.localId),
        needsSignIn: agent?.state === 'needsSignIn',
        runtimeTarget: resolveVoiceAttemptRecoveryRuntimeTarget({ agentRuntime: target.identity,
            serverId: context.serverId, machineId: context.machineId }),
    } };
}
