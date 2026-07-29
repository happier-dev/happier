import { ExternalSessionsAgentIdSchema } from '@happier-dev/protocol';

import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { fetchAccountProfile } from '@/api/accountProfile';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { readCredentials } from '@/persistence';
import {
    getActiveAccountSettingsSnapshot,
    resolveActiveAccountSettingsSnapshotRevision,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
    configuredExternalSessionSourcesUseConnectedProfiles,
    resolveConfiguredExternalSessionFollowTarget,
    type ConfiguredExternalSessionSourceAccountProjection,
    type ConfiguredExternalSessionSourceAgentContribution,
} from './configuredSourceMaterializer';
import type {
    ExternalSessionFollowTargetHostOperation,
    ExternalSessionFollowTargetHostOperationRequest,
} from './hostOperationOwner';
import type { PluginExternalSessionsProviderOps } from './pluginExternalSessionsAdapter';
import type { HostExternalSessionFollowTargetResolution } from './privateContract';

type FollowTargetRuntimeContext = Readonly<{
    pluginId: string;
    agentId: string;
    generationId: string;
    agent: ConfiguredExternalSessionSourceAgentContribution;
    providerOps: PluginExternalSessionsProviderOps;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    release(): Promise<void>;
}>;

type FollowTargetHostOperationDependencies = Readonly<{
    acquireRuntimeContext(
        agentId: string,
    ): Promise<FollowTargetRuntimeContext | null>;
    readAccount(
        agent: ConfiguredExternalSessionSourceAgentContribution,
        signal: AbortSignal,
    ): Promise<ConfiguredExternalSessionSourceAccountProjection>;
    readAccountRevision(): string;
}>;

function unavailable(code: string): HostExternalSessionFollowTargetResolution {
    return Object.freeze({ status: 'unavailable', code });
}

function requestIsCurrent(
    request: ExternalSessionFollowTargetHostOperationRequest,
    context: FollowTargetRuntimeContext,
): boolean {
    if (request.signal?.aborted || context.retirementSignal.aborted) return false;
    try {
        return request.isCurrent() === true && context.isCurrent() === true;
    } catch {
        return false;
    }
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

function createDefaultDependencies(): FollowTargetHostOperationDependencies {
    return Object.freeze({
        async acquireRuntimeContext(rawAgentId) {
            const parsedAgentId = ExternalSessionsAgentIdSchema.safeParse(rawAgentId);
            if (!parsedAgentId.success) return null;
            const registryLease =
                await acquireAuthoritativePluginRuntimeRegistryLease().catch(
                    () => null,
                );
            if (!registryLease) return null;
            const runtimeLease = registryLease.registry.agentRuntimesByAgentId.get(
                parsedAgentId.data,
            );
            const agent =
                registryLease.registry.contributes.agentDefinitionsById.get(
                    parsedAgentId.data,
                );
            if (
                !runtimeLease?.externalSessions
                || !runtimeLease.isCurrent()
                || runtimeLease.retirementSignal.aborted
                || !agent
            ) {
                await registryLease.release();
                return null;
            }
            const executionSurface = createAgentExternalSessionsExecutionSurface(
                runtimeLease.externalSessions,
                'unsupported',
            );
            if (
                typeof executionSurface.validateSource !== 'function'
                || typeof executionSurface.listCandidates !== 'function'
                || typeof executionSurface.pageTranscript !== 'function'
            ) {
                await registryLease.release();
                return null;
            }
            const providerOps: PluginExternalSessionsProviderOps = {
                validateSource: executionSurface.validateSource,
                listCandidates: executionSurface.listCandidates,
                pageTranscript: executionSurface.pageTranscript,
                ...(executionSurface.readAfterTranscript
                    ? {
                        readAfterTranscript:
                            executionSurface.readAfterTranscript,
                    }
                    : {}),
                ...(executionSurface.resolveLinkIdentity
                    ? {
                        resolveLinkIdentity:
                            executionSurface.resolveLinkIdentity,
                    }
                    : {}),
            };
            return Object.freeze({
                pluginId: runtimeLease.pluginId,
                agentId: runtimeLease.agentId,
                generationId: runtimeLease.generation,
                agent,
                providerOps,
                retirementSignal: runtimeLease.retirementSignal,
                isCurrent: runtimeLease.isCurrent,
                release: async () => await registryLease.release(),
            });
        },
        async readAccount(agent, signal) {
            if (!configuredExternalSessionSourcesUseConnectedProfiles([agent])) {
                return Object.freeze({ connectedServicesV2: [] });
            }
            const credentials = await readCredentials().catch(() => null);
            if (!credentials || signal.aborted) {
                throw new Error('External-session account projection unavailable');
            }
            return await fetchAccountProfile({
                token: credentials.token,
                signal,
            });
        },
        readAccountRevision: () =>
            resolveActiveAccountSettingsSnapshotRevision(
                getActiveAccountSettingsSnapshot(),
            ),
    });
}

export function createExternalSessionFollowTargetHostOperation(params: Readonly<{
    machineId: string;
    dependencies?: FollowTargetHostOperationDependencies;
}>): ExternalSessionFollowTargetHostOperation {
    const dependencies = params.dependencies ?? createDefaultDependencies();
    return Object.freeze({
        async execute(request) {
            if (
                request.machineId !== params.machineId
                || request.contributionId.trim().length === 0
                || request.remoteSessionId.trim().length === 0
                || !requestOwnerIsCurrent(request)
            ) {
                return unavailable(
                    request.signal?.aborted
                        ? 'plugin_operation_aborted'
                        : 'plugin_external_follow_identity_mismatch',
                );
            }
            const context = await dependencies.acquireRuntimeContext(
                request.contributionId,
            );
            if (!context) {
                return unavailable('plugin_external_follow_identity_unavailable');
            }
            try {
                if (
                    context.pluginId !== request.pluginId
                    || context.agentId !== request.contributionId
                    || context.generationId !== request.generationId
                    || dependencies.readAccountRevision() !== request.accountRevision
                    || !requestIsCurrent(request, context)
                ) {
                    return unavailable('plugin_generation_retired');
                }
                const signal = AbortSignal.any([
                    context.retirementSignal,
                    ...(request.signal ? [request.signal] : []),
                ]);
                const account = await dependencies.readAccount(
                    context.agent,
                    signal,
                );
                if (
                    dependencies.readAccountRevision() !== request.accountRevision
                    || !requestIsCurrent(request, context)
                ) {
                    return unavailable(
                        request.signal?.aborted
                            ? 'plugin_operation_aborted'
                            : 'plugin_generation_retired',
                    );
                }
                const basis = Object.freeze({
                    contributionGenerationId: request.generationId,
                    accountSettingsRevision: request.accountRevision,
                });
                return await resolveConfiguredExternalSessionFollowTarget({
                    agents: [context.agent],
                    account,
                    basis,
                    readCurrentBasis: () => Object.freeze({
                        contributionGenerationId: context.generationId,
                        accountSettingsRevision: dependencies.readAccountRevision(),
                    }),
                    isCurrent: () => (
                        dependencies.readAccountRevision()
                            === request.accountRevision
                        && requestIsCurrent(request, context)
                    ),
                    agentId: context.agentId,
                    remoteSessionId: request.remoteSessionId,
                    resolveProviderOps: async (agentId) => (
                        agentId === context.agentId
                            ? context.providerOps
                            : null
                    ),
                    signal,
                    retirementSignal: context.retirementSignal,
                });
            } catch {
                return unavailable(
                    request.signal?.aborted
                        ? 'plugin_operation_aborted'
                        : requestIsCurrent(request, context)
                            ? 'plugin_external_follow_identity_unavailable'
                            : 'plugin_generation_retired',
                );
            } finally {
                await context.release().catch(() => undefined);
            }
        },
    });
}
