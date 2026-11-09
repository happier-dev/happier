import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

import { fetchAccountProfile } from '@/api/accountProfile';
import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import {
    getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
    configuredExternalSessionSourcesUseConnectedProfiles,
    resolveConfiguredExternalSessionFollowTarget,
    type ConfiguredExternalSessionSourceAccountProjection,
    type ConfiguredExternalSessionSourceAgentContribution,
} from './configuredSourceMaterializer';
import { invokeBoundedExternalSessionsOperation } from './agentExternalSessionsInvocation';
import type {
    ExternalSessionFollowTargetHostOperation,
    ExternalSessionFollowTargetHostOperationRequest,
    ExternalSessionHostAccountContext,
} from './hostOperationOwner';
import type { HostExternalSessionFollowTargetResolution } from './privateContract';

type FollowTargetHostOperationDependencies = Readonly<{
    readAccount(
        agent: ConfiguredExternalSessionSourceAgentContribution,
        signal: AbortSignal,
    ): Promise<ConfiguredExternalSessionSourceAccountProjection>;
    readAgentSettings(): unknown;
    readActiveServerId(): string | null;
}>;

function unavailable(code: string): HostExternalSessionFollowTargetResolution {
    return Object.freeze({ status: 'unavailable', code });
}

function requestOwnerIsCurrent(
    request: ExternalSessionFollowTargetHostOperationRequest,
): boolean {
    if (request.signal?.aborted) return false;
    try {
        return request.isCurrent() === true;
    } catch {
        return false;
    }
}

function createDefaultDependencies(accountContext?: ExternalSessionHostAccountContext): FollowTargetHostOperationDependencies {
    return Object.freeze({
        async readAccount(agent, signal) {
            if (!configuredExternalSessionSourcesUseConnectedProfiles([agent])) {
                return Object.freeze({ connectedServicesV2: [] });
            }
            const credentials = accountContext
                ? accountContext.credentials
                : await readStoredCredentials().catch(() => null);
            if (!credentials || signal.aborted) {
                throw new Error('External-session account projection unavailable');
            }
            return await fetchAccountProfile({
                token: credentials.token,
                signal,
            });
        },
        readAgentSettings: () => accountContext ? accountContext.agentSettings : getActiveAccountSettingsSnapshot()?.settings,
        readActiveServerId: () => accountContext ? accountContext.serverId : configuration.activeServerId,
    });
}

export function createExternalSessionFollowTargetHostOperation(params: Readonly<{
    machineId: string;
    dependencies?: FollowTargetHostOperationDependencies;
}>): ExternalSessionFollowTargetHostOperation {
    return Object.freeze({
        async execute(request) {
            const dependencies = params.dependencies ?? createDefaultDependencies(request.accountContext);
            if (
                request.machineId !== params.machineId
                || request.contributionId.trim().length === 0
                // Agent-minted: presence is the only judgement, and the request
                // carries the exact bytes on to the provider operation.
                || readNonBlankOpaqueIdentifier(request.remoteSessionId) === null
                || !requestOwnerIsCurrent(request)
            ) {
                return unavailable(
                    request.signal?.aborted
                        ? 'plugin_operation_aborted'
                        : 'plugin_external_follow_identity_mismatch',
                );
            }
            if (!request.providerOps || !request.agentContribution) {
                return unavailable(
                    'plugin_external_follow_identity_unavailable',
                );
            }
            const signal = request.signal ?? new AbortController().signal;
            const agent = request.agentContribution;
            const providerOps = request.providerOps;
            const basis = Object.freeze({ accountSettingsRevision: request.accountRevision });
            const outcome = await invokeBoundedExternalSessionsOperation({
                signal,
                retirementSignal: signal,
                isCurrent: () => !signal.aborted,
                ...(request.admissionDeadlineAtMs === undefined
                    ? {}
                    : { deadlineAtMs: request.admissionDeadlineAtMs }),
                operation: async (admissionSignal, deadlineAtMs) => {
                    if (admissionSignal.aborted) {
                        throw admissionSignal.reason;
                    }
                    const account = await dependencies.readAccount(
                        agent,
                        admissionSignal,
                    );
                    if (admissionSignal.aborted) {
                        throw admissionSignal.reason;
                    }
                    return await resolveConfiguredExternalSessionFollowTarget({
                        agents: [agent],
                        resolveCatalogEntry: async agentId => agentId === request.contributionId
                            ? agent.catalogEntry ?? null : null,
                        account,
                        agentSettings: dependencies.readAgentSettings(),
                        activeServerId: dependencies.readActiveServerId(),
                        activeServerDir: request.accountContext ? request.accountContext.activeServerDir : configuration.activeServerDir,
                        basis,
                        readCurrentBasis: () => basis,
                        isCurrent: () => !admissionSignal.aborted,
                        agentId: request.contributionId,
                        remoteSessionId: request.remoteSessionId,
                        admissionDeadlineAtMs: deadlineAtMs,
                        resolveProviderOps: async (agentId) => (
                            agentId === request.contributionId
                                ? providerOps
                                : null
                        ),
                        signal: admissionSignal,
                        retirementSignal: signal,
                    });
                },
            });
            if (outcome.status === 'fulfilled') return outcome.value;
            if (outcome.status === 'retired') {
                return unavailable('plugin_generation_retired');
            }
            if (outcome.status === 'cancelled') {
                return unavailable('plugin_operation_aborted');
            }
            if (outcome.status === 'timeout') {
                return unavailable('plugin_operation_deadline_exceeded');
            }
            return Object.freeze({
                status: 'unavailable',
                code: 'plugin_external_follow_identity_unavailable',
                diagnostic: Object.freeze({ reason: 'operation_failed' }),
            });
        },
    });
}
