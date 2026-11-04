import type { ActionExecutorDeps } from '@happier-dev/protocol';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { projectAgentProviderBrokerApplications } from '@/providers/broker/applicationProjection';
import {
    normalizeSessionTeamCredentialLaunch,
    readSessionTeamCredentialResourceCatalog,
    SessionTeamCredentialLaunchUnavailableError,
    type NormalizedSessionTeamCredentialLaunch,
} from '@/session/services/sessionTeamCredentialLaunch';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { qualifySessionTeamCredentialProviderModels } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { assertSessionTeamCredentialNativeModel, type SessionTeamCredentialInstalledModelRead } from '@/providers/broker/sessionTeamCredentialNativeBinding';
import { assertTeamCredentialModelAdmission } from '@/providers/broker/teamCredentialModelCompatibility';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams';
import { projectTeamCredentialLaunchFailure } from '@/session/services/sessionTeamCredentialLaunchError';

/** The daemon's Team preparation adapter; domain admission stays with the shared normalizer. */
export async function prepareSessionTeamCredentialLaunch(input: Readonly<{
    options: SpawnSessionOptions;
    executionMachineId?: string;
    acceptedTeamCredentialBinding?: SessionTeamCredentialBindingIntentV1 | null;
    readInstalledTeamCredentialProviderModel?: SessionTeamCredentialInstalledModelRead;
    agentId: string | null;
    agentTargetKey: string;
    lease: PluginRuntimeRegistryLease;
    homeDomainAction: ActionExecutorDeps['homeDomainAction'];
    signal?: AbortSignal;
}>): Promise<NormalizedSessionTeamCredentialLaunch> {
    const { agentId, homeDomainAction } = input;
    if (!agentId) throw new SessionTeamCredentialLaunchUnavailableError('agent_unavailable', 'agent_requirements');
    const accepted = input.acceptedTeamCredentialBinding;
    if (input.options.existingSessionId && input.options.teamCredentialBindings?.some(binding =>
        binding.slot.kind === 'provider_model' && binding.resourceId !== null && binding.deliveryMode === 'vendor-native')
        && !(accepted?.resourceId && accepted.slot.kind === 'provider_model' && accepted.deliveryMode === 'vendor-native')) {
        throw new SessionTeamCredentialLaunchUnavailableError();
    }
    if (input.options.existingSessionId && accepted?.resourceId && accepted.slot.kind === 'provider_model'
        && accepted.deliveryMode === 'vendor-native') {
        const model = input.options.modelSelection?.ref;
        if (!model || model.agentTargetKey !== input.agentTargetKey || model.providerConnectionId !== null
            || !input.readInstalledTeamCredentialProviderModel
            || (accepted.providerModelSelection?.executionMachineId && accepted.providerModelSelection.executionMachineId !== input.executionMachineId)) {
            throw new SessionTeamCredentialLaunchUnavailableError();
        }
        try {
            const row = await input.readInstalledTeamCredentialProviderModel({ sessionId: input.options.existingSessionId,
                binding: accepted, agentTargetKey: input.agentTargetKey, modelId: model.modelId, signal: input.signal });
            assertSessionTeamCredentialNativeModel({ row, binding: accepted,
                agentTargetKey: input.agentTargetKey, modelId: model.modelId });
            await assertTeamCredentialModelAdmission({ model: { ...row, deliveryMode: 'vendor-native' },
                lease: input.lease, agentId, signal: input.signal });
            return { options: { ...input.options, teamCredentialBindings: [
                ...(input.options.teamCredentialBindings ?? []).filter(binding => binding.slot.kind !== 'provider_model'), accepted,
            ] }, teamModelRow: row };
        } catch (error) {
            throw projectTeamCredentialLaunchFailure(error, 'binding', 'team_credential_provider_selection_not_current');
        }
    }
    if (!homeDomainAction) throw new SessionTeamCredentialLaunchUnavailableError('provider_catalog_unavailable', 'resource_catalog');
    const applications = projectAgentProviderBrokerApplications({
        registry: input.lease.registry.contributes,
        agentTargetKey: input.agentTargetKey,
        acceptedProtocols: readLeasedAgentProviderRequirements({ lease: input.lease, agentId })?.acceptsProtocols ?? [],
    });
    return await normalizeSessionTeamCredentialLaunch({
        options: input.options, agentId, agentTargetKey: input.agentTargetKey,
        executionMachineId: input.executionMachineId,
        contributions: input.lease.registry.contributes, applications,
        readCatalog: async () => Promise.all((await readSessionTeamCredentialResourceCatalog({
            homeDomainAction, applications, ...(input.signal ? { signal: input.signal } : {}),
            ...(input.executionMachineId ? { executionMachineId: input.executionMachineId } : {}),
        })).map(resource => qualifySessionTeamCredentialProviderModels({ resource, lease: input.lease,
            agentId, signal: input.signal }))),
    });
}
