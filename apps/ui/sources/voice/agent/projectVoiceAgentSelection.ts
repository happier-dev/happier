import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveVoiceAgentRunBackendId } from '@happier-dev/protocol/voice/voiceAgentRunMetadataV1';
import type { VoiceAgentRuntimeProjection } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
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

export type VoiceSelectedAgentRuntimeReadiness = VoiceReadinessFact | 'pending' | 'unavailable';

/** An initialized Run owns active readiness; inventory owns passive authentication and installation. */
export function projectVoiceSelectedAgentReadiness(
    target: AgentExecutionTargetV1 | null,
    inventory: MachineAgentsSnapshot,
    context: Readonly<{ serverId: string | null | undefined; machineId: string | null | undefined;
        activeRuntime?: VoiceAgentRuntimeProjection;
        modelRoute?: Parameters<typeof resolveSelectedProviderRoute>[0] }>,
): Readonly<{ runtime: VoiceSelectedAgentRuntimeReadiness; selectedAgent?: VoiceRoleReadiness['selectedAgent'] }> {
    if (!target) return { runtime: 'unknown' };
    const bundledId = resolveBundledAgentIdFromContributionIdentity(target.identity);
    const agentId = bundledId ?? buildQualifiedPluginContributionKey(target.identity);
    const row = inventory.agents.find(agent => agent.agentId === agentId && agent.definitionId === target.definitionId);
    const observed = inventory.status === 'idle' || inventory.status === 'offline' || inventory.status === 'error'
        || row?.stale ? undefined : row;
    const activeReady = context.activeRuntime?.ready === true
        && context.activeRuntime.serverId === context.serverId && context.activeRuntime.machineId === context.machineId
        && resolveVoiceAgentRunBackendId(context.activeRuntime.backendTarget) === (target.definitionId ?? agentId);
    const providerRoute = !activeReady && context.modelRoute ? resolveSelectedProviderRoute(context.modelRoute) : null;
    const agent = providerRoute ? projectMachineAgentForCredential(observed, { credentialBindings: null, providerRoute }) : observed;
    let runtime: VoiceSelectedAgentRuntimeReadiness;
    if (activeReady || agent?.state === 'ready' || agent?.state === 'updateAvailable') runtime = 'ready';
    else if (agent?.state === 'needsSignIn' || agent?.state === 'notInstalled') runtime = 'missing';
    else if (agent?.state === 'installing') runtime = 'installing';
    else if (agent?.state === 'unsupported') runtime = 'incompatible';
    else if (inventory.status === 'loading') runtime = 'pending';
    else runtime = inventory.status === 'idle' ? 'unknown' : 'unavailable';
    return { runtime, selectedAgent: {
        title: row?.title ?? (bundledId ? resolveAgentCatalogTitle(bundledId) : target.identity.localId),
        needsSignIn: !activeReady && agent?.state === 'needsSignIn',
        runtimeTarget: resolveVoiceAttemptRecoveryRuntimeTarget({ agentRuntime: target.identity,
            serverId: context.serverId, machineId: context.machineId }),
    } };
}
