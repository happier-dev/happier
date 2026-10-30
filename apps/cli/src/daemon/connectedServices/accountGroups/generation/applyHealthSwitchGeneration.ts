import { buildQualifiedPluginContributionKey, type QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol';
import type { ConnectedServiceAuthGroupGenerationApplyInput, ConnectedServiceAuthGroupGenerationApplyResult } from '../switching/ConnectedServiceAuthGroupSwitchCoordinator';
import type { ConnectedServiceRuntimeRegistry } from '../../runtimeRegistry/registry';
import { buildConnectedServiceAuthGroupCommittedGenerationFact, buildConnectedServiceAuthGroupTargetEpochIdentity } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';

/** Apply a health-driven commit through the same durable owner used by quota rotation. */
export async function applyHealthSwitchGeneration(input: ConnectedServiceAuthGroupGenerationApplyInput<QualifiedConnectedAccountServiceRef>, deps: Readonly<{
    runtimeRegistry: ConnectedServiceRuntimeRegistry;
    consume: ConnectedServiceAuthGroupGenerationConsumer['consume'];
}>): Promise<ConnectedServiceAuthGroupGenerationApplyResult> {
    if (!input.activeProfileId) return { ok: false, errorCode: 'connected_service_active_profile_missing' };
    const serviceId = buildQualifiedPluginContributionKey(input.serviceId);
    const sessions = deps.runtimeRegistry.listTargets().flatMap(target => {
        const sessionId = target.sessionId;
        if (!sessionId) return [];
        const binding = target.activeBindings.find(binding => binding.serviceId === serviceId && binding.groupId === input.groupId);
        return binding ? [{ sessionId, activity: 'live' as const, fromProfileId: binding.profileId }] : [];
    });
    if (sessions.length === 0) return { ok: true };
    const decisionCommittedTarget = { serviceId, groupId: input.groupId, profileId: input.activeProfileId,
        generation: input.generation, credentialRevision: input.credentialRevision ?? null };
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
        decisionId: buildConnectedServiceAuthGroupTargetEpochIdentity(decisionCommittedTarget),
        provenance: 'runtime_failure', decisionCommittedTarget,
    });
    const result = await deps.consume({ committedGeneration, sessions,
        switchReason: 'automatic_runtime_failure', executionAuthority: 'runtime_recovery' });
    return result.outcome === 'adopted_current' ? { ok: true }
        : { ok: false, errorCode: `connected_service_generation_${result.outcome}` };
}
