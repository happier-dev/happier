import type {
    GenerationBoundExternalSessionObservation,
} from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import {
    ExternalAgentObservationResourceDescriptorV1Schema,
    type ExternalAgentObservationResourceDescriptorV1,
    type ExternalAgentObservationSnapshotV1,
} from '@happier-dev/protocol';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
    validateExternalSessionObservationWatchFileChanges,
} from '@/session/external/observationFileSetPathValidation';

import {
    createExternalSessionObservationProjection,
} from './createExternalSessionObservationProjection';
import {
    createExternalSessionObservationReconciler,
    type ExternalSessionObservationLinkIdentity,
    type ExternalSessionObservationResourceIdentity,
} from './createExternalSessionObservationReconciler';
import {
    createExternalAgentObservationFieldPublisher,
} from './publishExternalAgentObservationField';

type ObservationContributionLease = Readonly<{
    contribution: GenerationBoundExternalSessionObservation;
    filesystemReadAllowedPaths?: ReadonlySet<string>;
    retirementSignal?: AbortSignal;
    release(): Promise<void>;
}>;

type CreateExternalSessionObservationDaemonProjectionParams = Readonly<{
    acquireObservationContribution?: (
        resource: ExternalSessionObservationResourceIdentity,
    ) => Promise<ObservationContributionLease | null>;
    publishField?: (input: Readonly<{
        sessionId: string;
        fieldId: 'runtime.externalAgent';
        value: ExternalAgentObservationSnapshotV1;
    }>) => Promise<void>;
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    watchFile?: (file: string, onChange: (file: string) => void) => () => void;
    watchTopologyDirectory?: (
        directory: string,
        onStructuralChange: (changedPath?: string) => void,
    ) => () => void;
    shouldSendReadyNotification?: (sessionId: string) => boolean;
    requestTranscriptRefresh?: (input: Readonly<{
        sessionId: string;
        resource: Readonly<{
            linkGeneration: string;
            pluginGeneration: string;
        }>;
    }>) => unknown | Promise<unknown>;
    isTranscriptRefreshDemanded?: (input: Readonly<{
        sessionId: string;
        resource: Readonly<{
            linkGeneration: string;
            pluginGeneration: string;
        }>;
    }>) => boolean;
}>;

function admitExternalSessionObservationResourceDescriptor(params: Readonly<{
    descriptorInput: unknown;
    link: Pick<
        ExternalSessionObservationLinkIdentity,
        'linkedSource' | 'watchFileChanges'
    >;
    filesystemReadAllowedPaths: ReadonlySet<string>;
}>): ExternalAgentObservationResourceDescriptorV1 {
    const descriptor = ExternalAgentObservationResourceDescriptorV1Schema.parse(
        params.descriptorInput,
    );
    const requestedWatchFileChanges =
        descriptor.changeObservation === 'watch_file_changes'
            ? descriptor.watchFileChanges
            : undefined;
    const watchFileChanges = validateExternalSessionObservationWatchFileChanges({
        requested: requestedWatchFileChanges,
        linkedSource: params.link.linkedSource,
        filesystemReadAllowedPaths: params.filesystemReadAllowedPaths,
        previouslyAuthorizedFiles: new Set(
            params.link.watchFileChanges?.files ?? [],
        ),
    });
    if (requestedWatchFileChanges && !watchFileChanges) {
        throw new TypeError(
            'External Agent observation descriptor requested an unauthorized file set',
        );
    }
    if (descriptor.changeObservation === 'watch_file_changes') {
        if (!watchFileChanges) {
            throw new TypeError(
                'External Agent observation descriptor requested an unauthorized file set',
            );
        }
        return {
            resourceKey: descriptor.resourceKey,
            linkKey: descriptor.linkKey,
            changeObservation: descriptor.changeObservation,
            watchFileChanges,
        };
    }
    return {
        resourceKey: descriptor.resourceKey,
        linkKey: descriptor.linkKey,
        changeObservation: descriptor.changeObservation,
    };
}

async function acquireCurrentObservationContribution(
    resource: ExternalSessionObservationResourceIdentity,
): Promise<ObservationContributionLease | null> {
    const registryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
        const agentDefinition = [...registryLease.registry.contributes.agentDefinitionsById.values()]
            .find((candidate) => (
                candidate.identity?.pluginId === resource.pluginId
                && candidate.identity.localId === resource.agentLocalId
            ));
        if (agentDefinition) {
            await activateAgentRuntimeContributionOnDemand(
                registryLease.registry,
                agentDefinition.id,
            );
        }
        const runtimeLease = agentDefinition
            ? registryLease.registry.agentRuntimesByAgentId.get(agentDefinition.id)
            : undefined;
        if (
            !agentDefinition
            || !runtimeLease
            || !runtimeLease.isCurrent()
            || runtimeLease.agentId !== agentDefinition.id
            || runtimeLease.pluginId !== resource.pluginId
            || runtimeLease.generation !== resource.pluginGeneration
            || !runtimeLease.externalSessionObservation
        ) {
            await registryLease.release();
            return null;
        }
        return {
            contribution: runtimeLease.externalSessionObservation,
            filesystemReadAllowedPaths: new Set(
                registryLease.registry.filesystemReadAllowedPathsByPluginId?.get(
                    runtimeLease.pluginId,
                ) ?? [],
            ),
            retirementSignal: runtimeLease.retirementSignal,
            release: async () => await registryLease.release(),
        };
    } catch (error) {
        await registryLease.release();
        throw error;
    }
}

/**
 * Composes the daemon's generation-bound Agent leaf with the single admission,
 * reduction, expiry, and canonical session-state publication path.
 */
export function createExternalSessionObservationDaemonProjection(
    params: CreateExternalSessionObservationDaemonProjectionParams = {},
) {
    const publishField = params.publishField
        ?? createExternalAgentObservationFieldPublisher({
            shouldSendReadyNotification:
                params.shouldSendReadyNotification ?? (() => false),
        });
    const acquireContribution = params.acquireObservationContribution
        ?? acquireCurrentObservationContribution;
    const withContribution = async <T>(
        resource: ExternalSessionObservationResourceIdentity,
        operation: (
            contribution: GenerationBoundExternalSessionObservation,
            lease: Pick<
                ObservationContributionLease,
                'filesystemReadAllowedPaths' | 'retirementSignal'
            >,
        ) => Promise<T>,
    ): Promise<T> => {
        const lease = await acquireContribution(resource);
        if (!lease) {
            throw new Error('External Agent observation contribution is unavailable');
        }
        // Snapshot the generation-bound facade, then release registry custody
        // before invoking it. The facade's retirement signal owns cancellation;
        // retaining the registry lease across a pending leaf call would prevent
        // the controller from reaching that retirement.
        const contribution = lease.contribution;
        const leaseContext = {
            filesystemReadAllowedPaths: lease.filesystemReadAllowedPaths,
            retirementSignal: lease.retirementSignal,
        };
        await lease.release();
        return await operation(contribution, leaseContext);
    };
    const reconciler = createExternalSessionObservationReconciler({
        acquireObserver: async (input) => await withContribution(
            input.resource,
            async (contribution) => {
                const request = {
                    resourceKey: input.resource.resourceKey,
                    managedEndpointSource: input.managedEndpointSource,
                    signal: input.signal,
                    emit: input.emit,
                    requestReconcile: input.requestReconcile,
                    requestTranscriptRefresh: input.requestTranscriptRefresh,
                };
                return await contribution.observeResource(request);
            },
        ),
        requestTranscriptRefresh: params.requestTranscriptRefresh,
        isTranscriptRefreshDemanded: params.isTranscriptRefreshDemanded,
        reconcileResource: async (input) => await withContribution(
            input.resource,
            async (contribution, lease) => {
                const result = await contribution.reconcileResource({
                    purpose: input.purpose,
                    resourceKey: input.resource.resourceKey,
                    links: input.links.map((link) => ({
                        linkKey: link.linkKey,
                        linkedSource: link.linkedSource,
                    })),
                    signal: input.signal,
                });
                if (result.purpose !== 'resource_descriptors') {
                    return result;
                }
                return {
                    purpose: result.purpose,
                    outcomes: result.outcomes.map((outcome, index) => (
                        outcome.kind === 'unavailable'
                            ? outcome
                            : {
                                kind: outcome.kind,
                                descriptor:
                                    admitExternalSessionObservationResourceDescriptor({
                                        descriptorInput: outcome.descriptor,
                                        link: input.links[index]!,
                                        filesystemReadAllowedPaths:
                                            lease.filesystemReadAllowedPaths
                                            ?? new Set(),
                                    }),
                            }
                    )),
                };
            },
        ),
        ...(params.watchFile ? { watchFile: params.watchFile } : {}),
        ...(params.watchTopologyDirectory
            ? { watchTopologyDirectory: params.watchTopologyDirectory }
            : {}),
    });

    return createExternalSessionObservationProjection({
        reconciler,
        publishField,
        ...(params.now ? { now: params.now } : {}),
        ...(params.setTimer ? { setTimer: params.setTimer } : {}),
        ...(params.clearTimer ? { clearTimer: params.clearTimer } : {}),
    });
}
