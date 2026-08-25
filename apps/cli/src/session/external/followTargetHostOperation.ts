import { ExternalSessionsAgentIdSchema } from '@happier-dev/protocol';

import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { fetchAccountProfile } from '@/api/accountProfile';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import {
    getActiveAccountSettingsSnapshot,
    resolveActiveAccountConfiguredExternalSessionSourceRevision,
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
} from './hostOperationOwner';
import type { ExternalSessionFollowProviderOps } from './providerOps';
import type { HostExternalSessionFollowTargetResolution } from './privateContract';

type FollowTargetRuntimeContext = Readonly<{
    pluginId: string;
    agentId: string;
    generationId: string;
    agent: ConfiguredExternalSessionSourceAgentContribution;
    providerOps: ExternalSessionFollowProviderOps;
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
    readAgentSettings(): unknown;
    readActiveServerId(): string | null;
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
                || typeof executionSurface.resolveLinkIdentity !== 'function'
                || typeof executionSurface.pageTranscript !== 'function'
                || typeof executionSurface.readAfterTranscript !== 'function'
            ) {
                await registryLease.release();
                return null;
            }
            const providerOps: ExternalSessionFollowProviderOps = {
                validateSource: executionSurface.validateSource,
                pageTranscript: executionSurface.pageTranscript,
                readAfterTranscript: executionSurface.readAfterTranscript,
                resolveLinkIdentity: executionSurface.resolveLinkIdentity,
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
            const credentials = await readStoredCredentials().catch(() => null);
            if (!credentials || signal.aborted) {
                throw new Error('External-session account projection unavailable');
            }
            return await fetchAccountProfile({
                token: credentials.token,
                signal,
            });
        },
        readAccountRevision: () =>
            resolveActiveAccountConfiguredExternalSessionSourceRevision(
                getActiveAccountSettingsSnapshot(),
            ),
        readAgentSettings: () => getActiveAccountSettingsSnapshot()?.settings,
        readActiveServerId: () => configuration.activeServerId,
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
            if (request.providerOps && !request.agentContribution) {
                return unavailable(
                    'plugin_external_follow_identity_unavailable',
                );
            }
            const signal = request.signal ?? new AbortController().signal;
            const outcome = await invokeBoundedExternalSessionsOperation({
                signal,
                // The runtime-context retirement signal is not available until
                // acquisition completes. The admitted operation joins it before
                // every context-owned await below.
                retirementSignal: new AbortController().signal,
                isCurrent: () => requestOwnerIsCurrent(request),
                ...(request.admissionDeadlineAtMs === undefined
                    ? {}
                    : { deadlineAtMs: request.admissionDeadlineAtMs }),
                operation: async (admissionSignal, deadlineAtMs) => {
                    let context: FollowTargetRuntimeContext | null = null;
                    try {
                        context = request.providerOps && request.agentContribution
                            ? Object.freeze({
                                pluginId: request.pluginId,
                                agentId: request.contributionId,
                                generationId: request.generationId,
                                agent: request.agentContribution,
                                providerOps: request.providerOps,
                                retirementSignal: signal,
                                isCurrent: request.isCurrent,
                                release: async () => undefined,
                            })
                            : await dependencies.acquireRuntimeContext(
                                request.contributionId,
                            );
                        if (admissionSignal.aborted) {
                            throw admissionSignal.reason;
                        }
                        if (!context) {
                            return unavailable(
                                'plugin_external_follow_identity_unavailable',
                            );
                        }
                        const runtimeContext = context;
                        if (
                            runtimeContext.pluginId !== request.pluginId
                            || runtimeContext.agentId !== request.contributionId
                            || runtimeContext.generationId !== request.generationId
                            || dependencies.readAccountRevision()
                                !== request.accountRevision
                            || !requestIsCurrent(request, runtimeContext)
                        ) {
                            return unavailable('plugin_generation_retired');
                        }
                        const operationSignal = AbortSignal.any([
                            admissionSignal,
                            runtimeContext.retirementSignal,
                        ]);
                        if (operationSignal.aborted) {
                            throw operationSignal.reason;
                        }
                        const account = await dependencies.readAccount(
                            runtimeContext.agent,
                            operationSignal,
                        );
                        if (admissionSignal.aborted) {
                            throw admissionSignal.reason;
                        }
                        if (
                            dependencies.readAccountRevision()
                                !== request.accountRevision
                            || !requestIsCurrent(request, runtimeContext)
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
                            agents: [runtimeContext.agent],
                            account,
                            agentSettings: dependencies.readAgentSettings(),
                            activeServerId: dependencies.readActiveServerId(),
                            activeServerDir: configuration.activeServerDir,
                            basis,
                            readCurrentBasis: () => Object.freeze({
                                contributionGenerationId: runtimeContext.generationId,
                                accountSettingsRevision:
                                    dependencies.readAccountRevision(),
                            }),
                            isCurrent: () => (
                                dependencies.readAccountRevision()
                                    === request.accountRevision
                                && requestIsCurrent(request, runtimeContext)
                            ),
                            agentId: runtimeContext.agentId,
                            remoteSessionId: request.remoteSessionId,
                            admissionDeadlineAtMs: deadlineAtMs,
                            resolveProviderOps: async (agentId) => (
                                agentId === runtimeContext.agentId
                                    ? runtimeContext.providerOps
                                    : null
                            ),
                            signal: operationSignal,
                            retirementSignal: runtimeContext.retirementSignal,
                        });
                    } catch {
                        return unavailable(
                            request.signal?.aborted
                                ? 'plugin_operation_aborted'
                                : context && !requestIsCurrent(request, context)
                                    ? 'plugin_generation_retired'
                                    : 'plugin_external_follow_identity_unavailable',
                        );
                    } finally {
                        if (context) {
                            await context.release().catch(() => undefined);
                        }
                    }
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
            return unavailable('plugin_external_follow_identity_unavailable');
        },
    });
}
