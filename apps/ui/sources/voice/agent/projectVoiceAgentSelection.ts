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
import type { VoiceSessionSnapshot } from '@/voice/session/types';

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
        failedAttempt?: VoiceSessionSnapshot | null }>,
): Readonly<{ runtime: VoiceReadinessFact; selectedAgent?: VoiceRoleReadiness['selectedAgent'] }> {
    if (!target) return { runtime: 'unknown' };
    const bundledId = resolveBundledAgentIdFromContributionIdentity(target.identity);
    const agentId = bundledId ?? buildQualifiedPluginContributionKey(target.identity);
    const row = inventory.agents.find(agent => agent.agentId === agentId && agent.definitionId === target.definitionId);
    const agent = inventory.status === 'idle' || inventory.status === 'offline' || inventory.status === 'error'
        || row?.stale ? undefined : row;
    const attempt = context.failedAttempt;
    const admitted = attempt?.recoveryTarget;
    // A launch refusal is more specific than an unobserved or cached inventory.
    // Definition instances have no exact definition in the retained recovery target.
    const admittedSignedOut = admitted != null && target.definitionId === undefined
        && attempt?.errorCode === 'authentication_required' && attempt.errorMessage === 'agent_signed_out'
        && admitted?.serverId === context.serverId && admitted.machineId === context.machineId
        && admitted.agentRuntime?.pluginId === target.identity.pluginId
        && admitted.agentRuntime.localId === target.identity.localId;
    const runtime: VoiceReadinessFact = admittedSignedOut ? 'missing'
        : agent?.state === 'ready' || agent?.state === 'updateAvailable' ? 'ready'
        : agent?.state === 'needsSignIn' || agent?.state === 'notInstalled' ? 'missing'
            : agent?.state === 'installing' ? 'installing' : agent?.state === 'unsupported' ? 'incompatible' : 'unknown';
    return { runtime, selectedAgent: {
        title: row?.title ?? (bundledId ? resolveAgentCatalogTitle(bundledId) : target.identity.localId),
        needsSignIn: admittedSignedOut || agent?.state === 'needsSignIn',
        ...(admittedSignedOut ? { machineLabel: admitted.machineLabel } : {}),
        runtimeTarget: resolveVoiceAttemptRecoveryRuntimeTarget({ agentRuntime: target.identity,
            serverId: context.serverId, machineId: context.machineId }),
    } };
}
