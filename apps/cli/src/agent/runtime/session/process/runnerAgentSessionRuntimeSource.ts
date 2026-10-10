import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { ComposerAttachmentMessageAcceptedV1Schema, ComposerAttachmentResolveRequestV1Schema } from '@happier-dev/protocol/plugins/contributions/composerAttachmentRuntimeV1';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type {
    PluginRuntimeAuthoritySnapshotV1,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import type {
    ExternalSessionHostOperationPortFactory,
    RunnerAgentExternalSessionProviderOps,
    RunnerAgentSessionRuntimeSource,
} from '@/agent/runtime/registry/engineRegistry/types';
import type {
    AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';
import type {
    DaemonAgentRuntimeTurnContributionsBridge,
} from './agentRuntimeDaemonTurnContributionsBridge';
import {
    AgentRuntimeDaemonTurnPayloadV1Schema,
    ComposerStagedMediaAdmissionSettlementV1Schema,
} from './agentRuntimeRunnerProtocol';
import type {
    SessionModelTransitionProviderTargetAuthorizer,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import {
    classifyNativeAgentSessionEffectBoundaryError,
    createNativeAgentSessionEffectBoundaryError,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import {
    readCurrentRunnerAgentRuntimeDaemonServiceAuthority,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import {
    createRunnerManagedServiceInvocationOwner,
} from '@/plugins/runtime/invocation/services/createRunnerManagedServiceInvocationOwner';
import {
    admitCurrentRunnerSessionInput,
    attestCurrentRunnerAgentSessionOpen,
    authorizeCurrentAgentRuntimeDaemonModelTransition,
    closeCurrentRunnerTeamCredentialProviderBinding,
    createCurrentRunnerManagedProviderRunServices,
    dispatchCurrentAgentRuntimeDaemonServiceRequest,
    dispatchCurrentRunnerDaemonPluginService,
    isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition,
    openCurrentRunnerTeamCredentialProviderBinding,
    resolveCurrentAgentRuntimeDaemonTurnContributions,
} from './agentRuntimeDaemonServiceAuthorityClient';
import { loadRetainedAgentRuntimeLeaf } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import { runnerPinnedBundledCustodyCanSupersedeBootstrap } from '@/plugins/runtime/retainedPluginSourceAttestation';
import {
    resolveAgentContributionQualifiedId,
} from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    attachExactRunnerRetainedPluginGenerations,
} from '@/plugins/store/registry/generationCustodyRetirement';
import {
    readCurrentPluginImmutableGenerationIntegrityCurrentness,
} from '@/plugins/store/registry/generationStore';
import {
    createPluginRuntimeOccurrenceId,
    type PluginRuntimeOccurrenceId,
} from '@/plugins/runtime/runtimeSlots';
import { readPrivateBearerFile } from '@/daemon/privateBearerFile';
import {
    updateSessionMarkerRunnerManagedProviderAuthority,
} from '@/daemon/sessionRegistry';
import {
    AgentRuntimeDaemonSessionOpenRequestV1Schema,
    AgentRuntimeDaemonSessionDescriptorV1Schema,
    AgentRuntimeRunnerBootstrapV1Schema,
} from './agentRuntimeRunnerProtocol';
import {
    createRunnerAgentDaemonFacets,
} from './runnerAgentDaemonFacets';
import {
    prepareRunnerDaemonPluginServices,
} from './runnerDaemonPluginServices';
import { createRunnerManagedProviderConsumerAccess } from './runnerManagedProviderConsumerAccess';
import {
    composeProviderBindingMaterialization,
} from '@/providers/spawn/compose';
import {
    projectAgentRuntimeDaemonServiceTurnWitnessV1,
    type AgentRuntimeDaemonServiceTurnWitnessInputV1,
} from './agentRuntimeDaemonServiceTurnWitness';
import type {
    RunnerManagedServiceEndpointReadPort,
} from './managedServiceEndpointReadProtocol';
import {
    createRunnerManagedServicesCustodyPort,
    type RunnerManagedServicesCustodyPortV1,
} from './runnerManagedServicesCustody';
import {
    projectManifestAgentContribution,
} from '@/plugins/projection/registry/projectManifestAgentContribution';
import {
    createBoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';
import {
    createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import {
    createAgentExternalSessionsExecutionSurface,
} from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import {
    ExternalSessionProviderFailureError,
    type ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';

function createRunnerSourceUnavailableError(message: string): Error {
    const error = new Error(message) as Error & { code: string };
    error.code = 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING';
    return error;
}

function requireClaimedRunnerSource(
    source: RunnerAgentSessionRuntimeSource | null,
): RunnerAgentSessionRuntimeSource {
    if (!source) {
        throw createRunnerSourceUnavailableError(
            'Runner Agent session runtime authority has not been claimed',
        );
    }
    return source;
}

function assertBootstrapIdentityMatchesClaim(
    descriptor: z.infer<typeof AgentRuntimeDaemonSessionDescriptorV1Schema>,
    source: RunnerAgentSessionRuntimeSource,
): void {
    const identity = source.identity;
    const descriptorAgentDeclaration = descriptor.agentDeclaration;
    const claimedAgent = source.agentContribution;
    if (descriptorAgentDeclaration
        && claimedAgent.provenance !== descriptorAgentDeclaration.provenance) {
        throw createRunnerSourceUnavailableError(
            'Runner Agent session runtime authority does not match its admitted bootstrap identity (Agent declaration provenance)',
        );
    }
    const runnerOwnsPinnedSource =
        runnerPinnedBundledCustodyCanSupersedeBootstrap(
            descriptor.sourceCustody,
            identity.sourceCustody,
        );
    if (
        identity.pluginId !== descriptor.pluginId
        || (!runnerOwnsPinnedSource
            && identity.pluginVersion !== descriptor.pluginVersion)
        || identity.agentId !== descriptor.agentId
        || identity.backendId !== descriptor.backendId
        || identity.occurrenceId !== descriptor.occurrenceId
        || (!runnerOwnsPinnedSource && !pluginSourceCustodyV1Equal(
            identity.sourceCustody,
            descriptor.sourceCustody,
        ))
        || !descriptorAgentDeclaration
        || claimedAgent.pluginId !== descriptor.pluginId
        || claimedAgent.identity?.localId
            !== descriptorAgentDeclaration.definition.id
        || (!runnerOwnsPinnedSource && !isDeepStrictEqual(
            claimedAgent.richDefinition?.definition,
            descriptorAgentDeclaration.definition,
        ))
    ) {
        throw createRunnerSourceUnavailableError(
            'Runner Agent session runtime authority does not match its admitted bootstrap identity',
        );
    }
}

/**
 * Builds only a non-authoritative identity carrier before the canonical
 * Happier session exists. Every operation remains fenced until
 * prepareForSession claims the exact V2 session/runner authority document.
 */
export async function createRunnerAgentSessionRuntimeBootstrap(input: Readonly<{
    happyHomeDir: string;
    publicReleaseRing: PublicReleaseRingId;
    authorityFilePath: string;
    bootstrapFilePath: string;
}>): Promise<RunnerAgentSessionRuntimeSource | null> {
    let descriptor:
        z.infer<typeof AgentRuntimeDaemonSessionDescriptorV1Schema>;
    let launch: z.infer<typeof AgentRuntimeRunnerBootstrapV1Schema>['launch'];
    try {
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(
            JSON.parse(await readPrivateBearerFile(input.bootstrapFilePath)),
        );
        descriptor = bootstrap.descriptor;
        launch = bootstrap.launch;
    } catch {
        return null;
    }
    if (!descriptor.agentDeclaration) return null;
    const bootstrapAgentContribution =
        projectManifestAgentContribution({
            definition: descriptor.agentDeclaration.definition,
            provenance: descriptor.agentDeclaration.provenance,
            source: descriptor.agentDeclaration.source,
            pluginId: descriptor.pluginId,
        });
    const bootstrapAgentLocalId =
        bootstrapAgentContribution.identity?.localId;
    if (!bootstrapAgentLocalId) return null;

    let claimed: RunnerAgentSessionRuntimeSource | null = null;
    let claimSessionId: string | null = null;
    let claimPromise: Promise<void> | null = null;
    let claimRetirementBound = false;
    const requireClaimed = () => requireClaimedRunnerSource(claimed);
    const daemonTurnContributionsBridge:
        DaemonAgentRuntimeTurnContributionsBridge = Object.freeze({
            async admitSessionInput(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge?.admitSessionInput) {
                    return {
                        status: 'rejected',
                        code: 'session_input_target_unavailable',
                    };
                }
                return await bridge.admitSessionInput(params);
            },
            async resolvePrompt(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent turn contributions authority is unavailable',
                    );
                }
                return await bridge.resolvePrompt(params);
            },
            async resolveAgentComposition(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent turn composition authority is unavailable',
                    );
                }
                return await bridge.resolveAgentComposition(params);
            },
            async resolveComposerReference(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent turn contributions authority is unavailable',
                    );
                }
                return await bridge.resolveComposerReference(params);
            },
            async resolveComposerAttachment(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent turn contributions authority is unavailable',
                    );
                }
                return await bridge.resolveComposerAttachment(params);
            },
            async afterComposerAttachmentMessageAccepted(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent turn contributions authority is unavailable',
                    );
                }
                await bridge.afterComposerAttachmentMessageAccepted(params);
            },
            async settleComposerStagedMedia(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge?.settleComposerStagedMedia) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent staged-media settlement authority is unavailable',
                    );
                }
                await bridge.settleComposerStagedMedia(params);
            },
            async transformAgentContext(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent context authority is unavailable',
                    );
                }
                return await bridge.transformAgentContext(params);
            },
            async transformSessionInput(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent session-input authority is unavailable',
                    );
                }
                return await bridge.transformSessionInput(params);
            },
            async transformAgentRequest(params) {
                const bridge =
                    requireClaimed().daemonTurnContributionsBridge;
                if (!bridge) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent request-transform authority is unavailable',
                    );
                }
                return await bridge.transformAgentRequest(params);
            },
        });
    const daemonModelTransitionAuthorizer:
        SessionModelTransitionProviderTargetAuthorizer =
            async (params) => {
                const authorizer =
                    requireClaimed().daemonModelTransitionAuthorizer;
                if (!authorizer) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent model-transition authority is unavailable',
                    );
                }
                return await authorizer(params);
            };
    const externalSessionHostOperations:
        ExternalSessionHostOperationPortFactory =
            Object.freeze({
                bindSession(sessionId) {
                    let bound:
                        ReturnType<
                            ExternalSessionHostOperationPortFactory[
                                'bindSession'
                            ]
                        >
                        | null = null;
                    const requireBound = () => {
                        if (bound) return bound;
                        const factory =
                            requireClaimed()
                                .externalSessionHostOperations;
                        if (!factory) {
                            throw createRunnerSourceUnavailableError(
                                'Runner External Session authority is unavailable',
                            );
                        }
                        bound = factory.bindSession(sessionId);
                        return bound;
                    };
                    return Object.freeze({
                        async executeFollow(request) {
                            return await requireBound()
                                .executeFollow(request);
                        },
                        async executeProviderSessionFollow(request) {
                            return await requireBound()
                                .executeProviderSessionFollow(request);
                        },
                        async retire() {
                            await bound?.retire();
                        },
                    });
                },
            });
    const requireRetainedExternalSessionProviderOps = () => {
        const providerOps =
            requireClaimed()
                .retainedExternalSessionProviderOps;
        if (!providerOps) {
            throw createRunnerSourceUnavailableError(
                'Runner retained External Session authority is unavailable',
            );
        }
        return providerOps;
    };
    const retainedExternalSessionProviderOps:
        ExternalSessionExecutionSurface =
            Object.freeze({
                get externalLinkedTakeoverWriterSafety() {
                    return (claimed?.agentContribution
                        ?? bootstrapAgentContribution).richDefinition?.definition
                        .surfaces?.externalSession
                        .externalLinkedTakeover?.writerSafety
                        ?? 'unsupported';
                },
                async validateSource(params) {
                    return await requireRetainedExternalSessionProviderOps()
                        .validateSource!(params);
                },
                async listCandidates(params) {
                    return await requireRetainedExternalSessionProviderOps()
                        .listCandidates!(params);
                },
                async resolveLinkIdentity(params) {
                    return await requireRetainedExternalSessionProviderOps()
                        .resolveLinkIdentity!(params);
                },
                async canonicalizeLinkedSession(params) {
                    return await requireRetainedExternalSessionProviderOps()
                        .canonicalizeLinkedSession!(params);
                },
                async pageTranscript(params) {
                    return await requireRetainedExternalSessionProviderOps()
                        .pageTranscript!(params);
                },
                async readAfterTranscript(params) {
                    return await requireRetainedExternalSessionProviderOps()
                        .readAfterTranscript!(params);
                },
            });
    const managedServiceEndpointReadPort:
        RunnerManagedServiceEndpointReadPort = Object.freeze({
        async open(request, signal?: AbortSignal) {
            const port = requireClaimed().managedServiceEndpointReadPort;
            if (!port) {
                throw createRunnerSourceUnavailableError(
                    'Runner managed-server endpoint read authority is unavailable',
                );
            }
            return await port.open(request, signal);
        },
        async next(request, signal?: AbortSignal) {
            const port = requireClaimed().managedServiceEndpointReadPort;
            if (!port) {
                throw createRunnerSourceUnavailableError(
                    'Runner managed-server endpoint read authority is unavailable',
                );
            }
            return await port.next(request, signal);
        },
        async cancel(request) {
            const port = requireClaimed().managedServiceEndpointReadPort;
            if (!port) {
                throw createRunnerSourceUnavailableError(
                    'Runner managed-server endpoint read authority is unavailable',
                );
            }
            return await port.cancel(request);
        },
    });
    const managedServicesCustodyPort:
        RunnerManagedServicesCustodyPortV1 = Object.freeze({
        async dispatch(request, options) {
            const port = requireClaimed().managedServicesCustodyPort;
            if (!port) {
                throw createRunnerSourceUnavailableError(
                    'Runner managed-services Provider custody authority is unavailable',
                );
            }
            return await port.dispatch(request, options);
        },
    });
    const policyAgentRef = Object.freeze({
        pluginId: descriptor.pluginId,
        localId: bootstrapAgentLocalId,
    });
    const bootstrapVoiceAuthorityOccurrenceId = descriptor.occurrenceId;
    const resolveClaimedVoiceAuthority = () => {
        const authority =
            claimed?.agentSessionRealtimeVoiceAuthority
            ?? null;
        return (
            authority
            && authority.policyAgentRef.pluginId
                === policyAgentRef.pluginId
            && authority.policyAgentRef.localId
                === policyAgentRef.localId
        )
            ? authority
            : null;
    };
    const agentSessionRealtimeVoiceAuthority:
        AgentSessionRealtimeVoiceAuthority =
            Object.freeze({
                get occurrenceId() {
                    return (
                        claimed
                            ?.agentSessionRealtimeVoiceAuthority
                            ?.occurrenceId
                        ?? bootstrapVoiceAuthorityOccurrenceId
                    );
                },
                policyAgentRef,
                resolveDeclaration(provider) {
                    return resolveClaimedVoiceAuthority()
                        ?.resolveDeclaration(provider)
                        ?? null;
                },
                isCurrent(provider) {
                    return resolveClaimedVoiceAuthority()
                        ?.isCurrent(provider)
                        ?? false;
                },
                resolveProviderOccurrenceId(provider) {
                    return resolveClaimedVoiceAuthority()
                        ?.resolveProviderOccurrenceId(provider)
                        ?? null;
                },
                resolveRetirementSignal(provider) {
                    return resolveClaimedVoiceAuthority()
                        ?.resolveRetirementSignal(provider)
                        ?? null;
                },
                resolveConversation(input) {
                    return resolveClaimedVoiceAuthority()
                        ?.resolveConversation(input)
                        ?? null;
                },
            });

    return Object.freeze({
        ...(launch ? { startupRuntimeDescriptorV1: launch.runtimeDescriptorV1 } : {}),
        get agentContribution() {
            return claimed?.agentContribution
                ?? bootstrapAgentContribution;
        },
        identity: Object.freeze({
            get pluginId() {
                return claimed?.identity.pluginId
                    ?? descriptor.pluginId;
            },
            get pluginVersion() {
                return claimed?.identity.pluginVersion
                    ?? descriptor.pluginVersion;
            },
            get agentId() {
                return claimed?.identity.agentId
                    ?? descriptor.agentId;
            },
            get backendId() {
                return claimed?.identity.backendId
                    ?? descriptor.backendId;
            },
            get occurrenceId() {
                if (!claimed) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent canonical session authority has not been claimed',
                    );
                }
                return claimed.identity.occurrenceId;
            },
            get sourceCustody() {
                if (!claimed) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent canonical session authority has not been claimed',
                    );
                }
                return claimed.identity.sourceCustody;
            },
            get runtimeAuthority() {
                return claimed?.identity.runtimeAuthority
                    ?? descriptor.runtimeAuthority;
            },
            isCurrent: () => claimed?.identity.isCurrent() ?? false,
        }),
        async prepareForSession({ sessionId, signal }) {
            const canonicalSessionId = sessionId.trim();
            if (!canonicalSessionId) {
                throw createRunnerSourceUnavailableError(
                    'Runner Agent canonical session id is required',
                );
            }
            signal.throwIfAborted();
            if (
                claimSessionId !== null
                && claimSessionId !== canonicalSessionId
            ) {
                throw createRunnerSourceUnavailableError(
                    'Runner Agent bootstrap is already bound to another session',
                );
            }
            claimSessionId = canonicalSessionId;
            claimPromise ??= (async () => {
                const source =
                    await createRunnerAgentSessionRuntimeSource({
                        happyHomeDir: input.happyHomeDir,
                        publicReleaseRing: input.publicReleaseRing,
                        authorityFilePath: input.authorityFilePath,
                        expectedSessionId: canonicalSessionId,
                        occurrenceId: descriptor.occurrenceId,
                        runtimeAuthority: descriptor.runtimeAuthority,
                    });
                if (!source) {
                    throw createRunnerSourceUnavailableError(
                        'Runner Agent canonical session authority is unavailable',
                    );
                }
                let assigned = false;
                try {
                    assertBootstrapIdentityMatchesClaim(
                        descriptor,
                        source,
                    );
                    signal.throwIfAborted();
                    claimed = source;
                    assigned = true;
                    if (!claimRetirementBound) {
                        claimRetirementBound = true;
                        const claimedSource = source;
                        signal.addEventListener(
                            'abort',
                            () => {
                                void claimedSource.retire?.()
                                    .catch(() => undefined);
                            },
                            { once: true },
                        );
                    }
                    if (signal.aborted) {
                        await source.retire?.();
                        signal.throwIfAborted();
                    }
                } catch (error) {
                    if (!assigned) {
                        await source.retire?.()
                            .catch(() => undefined);
                    }
                    throw error;
                }
            })();
            await claimPromise;
            signal.throwIfAborted();
        },
        async createRuntime(params) {
            return await requireClaimed().createRuntime(params);
        },
        async createInvocationServices(params) {
            return requireClaimed().createInvocationServices(params);
        },
        async prepareManagedProviderBinding(params) {
            return await requireClaimed()
                .prepareManagedProviderBinding?.(params) ?? null;
        },
        async authorizeNewTurn(witness, options) {
            return await requireClaimed()
                .authorizeNewTurn(witness, options);
        },
        async attestSessionOpen(params) {
            await requireClaimed()
                .attestSessionOpen?.(params);
        },
        managedProviderRunServices: {
            async resolvePurpose(request: Parameters<ReturnType<typeof createCurrentRunnerManagedProviderRunServices>['resolvePurpose']>[0]) {
                const services = requireClaimed().managedProviderRunServices;
                if (!services) throw createRunnerSourceUnavailableError('Runner managed Provider authority is unavailable');
                return await services.resolvePurpose(request);
            },
            async openBinding(request: Parameters<ReturnType<typeof createCurrentRunnerManagedProviderRunServices>['openBinding']>[0]) {
                const services = requireClaimed().managedProviderRunServices;
                if (!services) throw createRunnerSourceUnavailableError('Runner managed Provider authority is unavailable');
                return await services.openBinding(request);
            },
            async readBinding(request: Parameters<ReturnType<typeof createCurrentRunnerManagedProviderRunServices>['readBinding']>[0]) {
                const services = requireClaimed().managedProviderRunServices;
                if (!services) throw createRunnerSourceUnavailableError('Runner managed Provider authority is unavailable');
                return await services.readBinding(request);
            },
            async closeBinding(request: Parameters<ReturnType<typeof createCurrentRunnerManagedProviderRunServices>['closeBinding']>[0]) {
                const services = requireClaimed().managedProviderRunServices;
                if (!services) throw createRunnerSourceUnavailableError('Runner managed Provider authority is unavailable');
                await services.closeBinding(request);
            },
        },
        async prepareTeamCredentialProviderBinding(params) {
            const source = requireClaimed();
            if (!source.prepareTeamCredentialProviderBinding) {
                throw createRunnerSourceUnavailableError(
                    'Runner Team credential Provider binding authority is unavailable',
                );
            }
            return await source.prepareTeamCredentialProviderBinding(params);
        },
        async retire() {
            const retiring = claimed;
            await retiring?.retire?.();
            if (claimed === retiring) {
                // Native runtime recovery disposes this claim's invocation
                // scope. A later runtime must re-read and verify the exact
                // daemon authority, not reuse the retired claim promise.
                claimPromise = null;
                claimRetirementBound = false;
            }
        },
        daemonTurnContributionsBridge,
        daemonModelTransitionAuthorizer,
        externalSessionHostOperations,
        retainedExternalSessionProviderOps,
        managedServiceEndpointReadPort,
        resolveProviderCliAttachManagedServiceAccess: async (request) =>
            await requireClaimed().resolveProviderCliAttachManagedServiceAccess?.(request) ?? null,
        managedServicesCustodyPort,
        agentSessionRealtimeVoiceAuthority,
    });
}

export async function createRunnerAgentSessionRuntimeSource(input: Readonly<{
    happyHomeDir: string;
    publicReleaseRing: PublicReleaseRingId;
    authorityFilePath: string;
    expectedSessionId?: string;
    occurrenceId?: string;
    runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
}>): Promise<RunnerAgentSessionRuntimeSource | null> {
    const authority =
        await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
            happyHomeDir: input.happyHomeDir,
            publicReleaseRing: input.publicReleaseRing,
            path: input.authorityFilePath,
            ...(input.expectedSessionId
                ? { expectedSessionId: input.expectedSessionId }
                : {}),
        });
    if (!authority) return null;

    const binding = authority.retainedAgent;
    if (
        binding.sourceCustody.kind === 'development'
        && !input.occurrenceId?.trim()
    ) {
        return null;
    }
    // The private bootstrap schema has already bounded and validated this
    // daemon-minted opaque id; direct construction mints one locally.
    const runnerOccurrenceId: PluginRuntimeOccurrenceId = input.occurrenceId
        ? input.occurrenceId as PluginRuntimeOccurrenceId
        : createPluginRuntimeOccurrenceId(binding.pluginId);
    const bindingManagedGenerationId =
        binding.sourceCustody.kind === 'managed'
            ? binding.sourceCustody.immutableGenerationId
            : null;
    const lifetime = new AbortController();
    const storePaths = resolvePluginStorePaths({
        happyHomeDir: input.happyHomeDir,
    });
    const expectedAuthority = Object.freeze({
        happyHomeDir: input.happyHomeDir,
        publicReleaseRing: input.publicReleaseRing,
        path: input.authorityFilePath,
        sessionId: authority.sessionId,
        runner: authority.runner,
        retainedAgent: binding,
    });
    const runnerManagedServiceOwner =
        await createRunnerManagedServiceInvocationOwner({
            paths: storePaths,
            authority: expectedAuthority,
            retainedAgent: binding,
            ...(binding.sourceCustody.kind === 'development'
                ? { developmentOccurrenceId: runnerOccurrenceId }
                : {}),
        });
    const verifiedAgentDeclaration =
        runnerManagedServiceOwner.verifiedAgentDeclaration;
    const verifiedAgentContribution =
        projectManifestAgentContribution({
            definition: verifiedAgentDeclaration.definition,
            provenance: verifiedAgentDeclaration.provenance,
            source: {
                kind: verifiedAgentDeclaration.provenance === 'first_party'
                    ? 'bundled'
                    : 'package',
            },
            pluginId: binding.pluginId,
        });
    const invocationServiceOwners =
        runnerManagedServiceOwner.owners;
    const managedServicesCustodyOwner =
        createRunnerManagedServicesCustodyPort({
            resolveAuthorizedServicesForSupervise: (scope) =>
                runnerManagedServiceOwner
                    .resolveAuthorizedManagedProviderServices(scope),
            readCurrentProviderPluginHardRevocationRevision:
                (pluginId) => runnerManagedServiceOwner
                    .readCurrentProviderPluginHardRevocationRevision(
                        pluginId,
                    ),
            readCurrentProviderSourceCustodyIntegrityCurrentness:
                (providerAuthority) => providerAuthority.sourceCustody.kind
                    !== 'managed'
                    || readCurrentPluginImmutableGenerationIntegrityCurrentness({
                        paths: storePaths,
                        pluginId: providerAuthority.pluginId,
                        immutableGenerationId:
                            providerAuthority.sourceCustody
                                .immutableGenerationId,
                    }),
            projectEndpointAccess: (projectionInput) =>
                runnerManagedServiceOwner
                    .projectManagedProviderEndpointAccess(
                        projectionInput,
                    ),
            materializeAgentBinding: (materializeInput) =>
                runnerManagedServiceOwner
                    .materializeManagedProviderAgentBinding(
                        materializeInput,
                    ),
            retainAdoptedProviderAuthority: (providerAuthority) =>
                attachExactRunnerRetainedPluginGenerations({
                    paths: storePaths,
                    immutableGenerationIds:
                        providerAuthority.sourceCustody.kind === 'managed'
                            ? [providerAuthority.sourceCustody
                                .immutableGenerationId]
                            : [],
                    attach: async () =>
                        await updateSessionMarkerRunnerManagedProviderAuthority({
                            pid: authority.runner.pid,
                            sessionId: authority.sessionId,
                            processCommandHash:
                                authority.runner.processCommandHash,
                            processStartTimeMs:
                                authority.runner.processStartTimeMs,
                            authority: providerAuthority,
                        }),
                }),
            releaseAdoptedProviderAuthority: (providerAuthority) =>
                updateSessionMarkerRunnerManagedProviderAuthority({
                    pid: authority.runner.pid,
                    sessionId: authority.sessionId,
                    processCommandHash:
                        authority.runner.processCommandHash,
                    processStartTimeMs:
                        authority.runner.processStartTimeMs,
                    authority: null,
                    expectedAuthority: providerAuthority,
                }),
        });
    runnerManagedServiceOwner.bindManagedServicesCustodyRequestPort(
        managedServicesCustodyOwner.exactHandleRequestPort,
    );
    let readActiveTurnAdmissionWitness:
        (() => AgentRuntimeDaemonServiceTurnWitnessInputV1 | null)
        | null = null;
    let runtimeLeafPromise:
        ReturnType<typeof loadRetainedAgentRuntimeLeaf> | null = null;
    const prepareRuntimeLeaf = async () => {
        runtimeLeafPromise ??=
            loadRetainedAgentRuntimeLeaf({
                paths: storePaths,
                binding,
                ...(binding.sourceCustody.kind === 'development'
                    ? { developmentOccurrenceId: runnerOccurrenceId }
                    : {}),
            }).catch((error: unknown) => {
                if (binding.sourceCustody.kind !== 'development') throw error;
                const message = error instanceof Error
                    ? error.message
                    : 'current trusted development Agent source is unavailable';
                throw createRunnerSourceUnavailableError(message);
            });
        await runtimeLeafPromise;
    };
    // One retained External Sessions authority for this Session: the exact
    // durable source custody that admitted it. Both the runner's own private
    // composition and the daemon-forwarded provider requests of an already
    // admitted private follow read this single surface, so no second
    // decision-maker can answer for the same Session.
    const retainedExternalLinkedTakeoverWriterSafety =
        verifiedAgentContribution.richDefinition?.definition
            .surfaces?.externalSession.externalLinkedTakeover?.writerSafety
        ?? 'unsupported';
    let retainedExternalSessionSurfacePromise:
        Promise<ExternalSessionExecutionSurface | null> | null = null;
    const resolveRetainedExternalSessionSurface = async () => {
        retainedExternalSessionSurfacePromise ??= (async () => {
            await prepareRuntimeLeaf();
            const companion = (await runtimeLeafPromise!)
                .externalSessions;
            if (!companion || lifetime.signal.aborted) return null;
            return createAgentExternalSessionsExecutionSurface(
                createBoundedAgentExternalSessionsContribution({
                    contribution: companion,
                    identity: {
                        pluginId: binding.pluginId,
                        agentId: binding.agentId,
                        occurrenceId: runnerOccurrenceId,
                        contributionQualifiedId:
                            resolveAgentContributionQualifiedId({
                                pluginId: binding.pluginId,
                                localId: binding.localAgentId,
                            }),
                        sourceCustody: binding.sourceCustody,
                    },
                    isCurrent: () => !lifetime.signal.aborted,
                    retirementSignal: lifetime.signal,
                    createInvocationExec: async () => (
                        createUnavailablePluginServices().exec
                    ),
                    managedEndpointRead: async ({
                        identity,
                        signal,
                    }) => runnerManagedServiceOwner
                        .bindAgentExternalSessionsManagedEndpoint({
                            identity,
                            signal,
                        }),
                }),
                retainedExternalLinkedTakeoverWriterSafety,
            );
        })();
        return await retainedExternalSessionSurfacePromise;
    };
    const requireRetainedExternalSessionSurface = async (
        operation: keyof RunnerAgentExternalSessionProviderOps,
    ): Promise<RunnerAgentExternalSessionProviderOps> => {
        const surface = await resolveRetainedExternalSessionSurface();
        if (
            !surface?.validateSource
            || !surface.listCandidates
            || !surface.resolveLinkIdentity
            || !surface.canonicalizeLinkedSession
            || !surface.pageTranscript
            || !surface.readAfterTranscript
        ) {
            throw new ExternalSessionProviderFailureError({
                code: 'plugin_external_sessions_companion_unavailable',
                message:
                    'The retained Agent generation has no authenticated External Sessions companion',
                operation,
                retryable: false,
            });
        }
        return surface as RunnerAgentExternalSessionProviderOps;
    };
    const retainedExternalSessionProviderOps:
        ExternalSessionExecutionSurface = Object.freeze({
            externalLinkedTakeoverWriterSafety:
                retainedExternalLinkedTakeoverWriterSafety,
            async validateSource(request) {
                return await (
                    await requireRetainedExternalSessionSurface('validateSource')
                ).validateSource(request);
            },
            async listCandidates(request) {
                return await (
                    await requireRetainedExternalSessionSurface('listCandidates')
                ).listCandidates(request);
            },
            async resolveLinkIdentity(request) {
                return await (
                    await requireRetainedExternalSessionSurface('resolveLinkIdentity')
                ).resolveLinkIdentity(request);
            },
            async canonicalizeLinkedSession(request) {
                return await (
                    await requireRetainedExternalSessionSurface('canonicalizeLinkedSession')
                ).canonicalizeLinkedSession(request);
            },
            async pageTranscript(request) {
                return await (
                    await requireRetainedExternalSessionSurface('pageTranscript')
                ).pageTranscript(request);
            },
            async readAfterTranscript(request) {
                return await (
                    await requireRetainedExternalSessionSurface('readAfterTranscript')
                ).readAfterTranscript(request);
            },
        });
    const daemonFacets =
        await createRunnerAgentDaemonFacets({
            authority: expectedAuthority,
            readActiveTurnAdmissionWitness: () =>
                readActiveTurnAdmissionWitness?.() ?? null,
            resolveRetainedExternalSessionProviderOps: async () => {
                const surface =
                    await resolveRetainedExternalSessionSurface();
                if (!surface) return null;
                const {
                    validateSource,
                    resolveLinkIdentity,
                    pageTranscript,
                    readAfterTranscript,
                } = surface;
                if (
                    !validateSource
                    || !resolveLinkIdentity
                    || !pageTranscript
                    || !readAfterTranscript
                ) return null;
                return Object.freeze({
                    validateSource,
                    resolveLinkIdentity,
                    pageTranscript,
                    readAfterTranscript,
                });
            },
        });
    let retirePromise: Promise<void> | null = null;
    const retireSource = (): Promise<void> => {
        lifetime.abort();
        readActiveTurnAdmissionWitness = null;
        runnerManagedServiceOwner.clearEndpointAuth();
        if (retirePromise) return retirePromise;
        const attempt = (async () => {
            const results = await Promise.allSettled([
                daemonFacets.dispose(),
                managedServicesCustodyOwner.dispose(),
                invocationServiceOwners.dispose(),
            ]);
            const failures = results.flatMap((result) =>
                result.status === 'rejected'
                    ? [result.reason]
                    : []);
            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    'Failed to retire runner Agent session runtime source',
                );
            }
        })();
        let trackedAttempt!: Promise<void>;
        trackedAttempt = attempt.catch((error: unknown) => {
            if (retirePromise === trackedAttempt) retirePromise = null;
            throw error;
        });
        retirePromise = trackedAttempt;
        return trackedAttempt;
    };
    const retireSourceOnAbort = () => {
        void retireSource().catch(() => undefined);
    };
    const daemonTurnContributionsBridge:
        DaemonAgentRuntimeTurnContributionsBridge =
            Object.freeze({
                async admitSessionInput(params) {
                    if (
                        params.sessionId !== expectedAuthority.sessionId
                        || params.request.sessionId !== expectedAuthority.sessionId
                    ) {
                        return {
                            status: 'rejected',
                            code: 'session_input_source_authority_mismatch',
                        };
                    }
                    return await admitCurrentRunnerSessionInput({
                        authority: expectedAuthority,
                        requestId: randomUUID(),
                        request: params.request,
                        ...(params.signal
                            ? { signal: params.signal }
                            : {}),
                    });
                },
                async resolvePrompt(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'prompt',
                                ...(params.selectedAsset
                                    ? { selectedAsset: params.selectedAsset }
                                    : {}),
                                ...(params.machineId
                                    ? { machineId: params.machineId }
                                    : {}),
                                ...(params.featureIds
                                    ? { featureIds: [...params.featureIds] }
                                    : {}),
                                ...(params.excludePluginIds
                                    ? {
                                        excludePluginIds:
                                            [...params.excludePluginIds],
                                    }
                                    : {}),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'prompt') {
                        throw new Error(
                            'Daemon returned the wrong prompt contributions',
                        );
                    }
                    return result;
                },
                async resolveAgentComposition(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'composition',
                                runtimeFamily: params.runtimeFamily,
                                ...(params.machineId
                                    ? { machineId: params.machineId }
                                    : {}),
                                ...(params.featureIds
                                    ? { featureIds: [...params.featureIds] }
                                    : {}),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'composition') {
                        throw new Error(
                            'Daemon returned the wrong Agent composition contribution',
                        );
                    }
                    return result;
                },
                async resolveComposerReference(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'composerReference',
                                reference: params.reference,
                                candidateId: params.candidateId,
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'composerReference') {
                        throw new Error(
                            'Daemon returned the wrong Composer reference contribution',
                        );
                    }
                    return result.resolution;
                },
                async resolveComposerAttachment(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'composerAttachment',
                                attachment: params.attachment,
                                request: ComposerAttachmentResolveRequestV1Schema.parse(
                                    params.request,
                                ),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'composerAttachment') {
                        throw new Error(
                            'Daemon returned the wrong Composer attachment contribution',
                        );
                    }
                    return result.result;
                },
                async afterComposerAttachmentMessageAccepted(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'composerAttachmentAccepted',
                                attachment: params.attachment,
                                event: ComposerAttachmentMessageAcceptedV1Schema.parse(
                                    params.event,
                                ),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'composerAttachmentAccepted') {
                        throw new Error(
                            'Daemon returned the wrong Composer attachment acceptance contribution',
                        );
                    }
                },
                async settleComposerStagedMedia(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'settleComposerStagedMedia',
                                outcome: params.outcome,
                                settlement:
                                    ComposerStagedMediaAdmissionSettlementV1Schema
                                        .parse(params.settlement),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'settleComposerStagedMedia') {
                        throw new Error(
                            'Daemon returned the wrong staged-media settlement contribution',
                        );
                    }
                },
                async transformAgentContext(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'transformAgentContext',
                                payload:
                                    AgentRuntimeDaemonTurnPayloadV1Schema
                                        .parse(params.payload),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'transformAgentContext') {
                        throw new Error(
                            'Daemon returned the wrong Agent context transformation',
                        );
                    }
                    return result.payload;
                },
                async transformSessionInput(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'transformSessionInput',
                                payload:
                                    AgentRuntimeDaemonTurnPayloadV1Schema
                                        .parse(params.payload),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'transformSessionInput') {
                        throw new Error(
                            'Daemon returned the wrong session input transformation',
                        );
                    }
                    return result.payload;
                },
                async transformAgentRequest(params) {
                    const result =
                        await resolveCurrentAgentRuntimeDaemonTurnContributions({
                            authority: expectedAuthority,
                            requestId: randomUUID(),
                            request: {
                                kind: 'transformAgentRequest',
                                payload:
                                    AgentRuntimeDaemonTurnPayloadV1Schema
                                        .parse(params.payload),
                            },
                            ...(params.signal
                                ? { signal: params.signal }
                                : {}),
                        });
                    if (result.kind !== 'transformAgentRequest') {
                        throw new Error(
                            'Daemon returned the wrong Agent request transformation',
                        );
                    }
                    return result.payload;
                },
            });
    const daemonModelTransitionAuthorizer:
        SessionModelTransitionProviderTargetAuthorizer =
            async (params) =>
                await authorizeCurrentAgentRuntimeDaemonModelTransition({
                    authority: expectedAuthority,
                    requestId: randomUUID(),
                    selection: params.selection,
                });
    let runtimePromise: Promise<AgentRuntime> | null = null;
    let preparedManagedProviderBindingPromise:
        ReturnType<
            NonNullable<
                RunnerAgentSessionRuntimeSource[
                    'prepareManagedProviderBinding'
                ]
            >
        > | null = null;
    let preparedManagedProviderPluginServices:
        PluginServices | null = null;
    return Object.freeze({
        agentContribution: verifiedAgentContribution,
        identity: Object.freeze({
            pluginId: binding.pluginId,
            pluginVersion: binding.pluginVersion,
            // The admitted binding already carries the exact host routing id,
            // including released first-party ids whose spelling is not the
            // manifest-local id. Never re-derive an alias here.
            agentId: binding.agentId,
            backendId: binding.agentId,
            occurrenceId: runnerOccurrenceId,
            sourceCustody: binding.sourceCustody,
            ...(input.runtimeAuthority
                ? { runtimeAuthority: input.runtimeAuthority }
                : {}),
            isCurrent: () => !lifetime.signal.aborted,
        }),
        async createRuntime({ signal }) {
            signal.addEventListener(
                'abort',
                retireSourceOnAbort,
                { once: true },
            );
            if (signal.aborted) {
                await retireSource();
                signal.throwIfAborted();
            }
            runtimePromise ??= (async () => {
                await prepareRuntimeLeaf();
                const leaf = await runtimeLeafPromise!;
                signal.throwIfAborted();
                return await leaf.factory({
                    plugin: Object.freeze({
                        id: binding.pluginId,
                        version: binding.pluginVersion,
                    }),
                    agent: Object.freeze({
                        id: binding.localAgentId,
                    }),
                    signal,
                });
            })();
            return await runtimePromise;
        },
        async prepareManagedProviderBinding(params) {
            if (!preparedManagedProviderBindingPromise) {
                preparedManagedProviderBindingPromise = (async () => {
                const seed = Object.freeze({
                    plugin: Object.freeze({
                        id: binding.pluginId,
                        version: binding.pluginVersion,
                    }),
                    contribution: Object.freeze({
                        id: binding.localAgentId,
                        qualifiedId:
                            resolveAgentContributionQualifiedId({
                                pluginId: binding.pluginId,
                                localId: binding.localAgentId,
                            }),
                    }),
                    occurrenceId: runnerOccurrenceId,
                    sourceCustody: binding.sourceCustody,
                    correlationId: params.sessionId,
                    surface: 'agent' as const,
                    session: params.session,
                    currentSession: params.session.current,
                    signal: params.signal,
                    readActiveTurnAdmissionWitness:
                        params.readActiveTurnAdmissionWitness,
                    isOccurrenceCurrent: () =>
                        !lifetime.signal.aborted,
                });
                const localServices =
                    invocationServiceOwners.createOperationServices(seed, {
                        filesystemRoots: Object.freeze({
                            pluginData: join(
                                storePaths.storageDir,
                                binding.pluginId,
                                'fs',
                            ),
                            workspace: params.cwd,
                            projects: new Map(),
                        }),
                        environment: params.environment,
                        hostAccessRequests:
                            runnerManagedServiceOwner.hostAccessRequests,
                    });
                let prepared: Awaited<ReturnType<
                    NonNullable<
                        RunnerAgentSessionRuntimeSource[
                            'prepareManagedProviderBinding'
                        ]
                    >
                >> = null;
                const pluginServices =
                    await prepareRunnerDaemonPluginServices({
                    invocationId: params.sessionId,
                    signal: params.signal,
                    dispatch: async (operation, options) =>
                        await dispatchCurrentRunnerDaemonPluginService({
                            authority: expectedAuthority,
                            operation,
                            ...(options?.timeoutMs !== undefined
                                ? { timeoutMs: options.timeoutMs }
                                : {}),
                            ...(options?.signal
                                ? { signal: options.signal }
                                : {}),
                        }),
                    isAuthorityTransitionError:
                        isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition,
                    readManagedProviderRetention: () =>
                        managedServicesCustodyOwner
                            .readCurrentManagedProviderRetention(),
                    bindManagedServices: (bindingInput) =>
                        runnerManagedServiceOwner.bindManagedServices({
                            seed,
                            agent: {
                                connectedAccounts:
                                    bindingInput.connectedAccounts,
                                exec: bindingInput.exec,
                            },
                            managedProvider:
                                bindingInput.managedProvider,
                        }),
                    onManagedProviderStarted: async ({
                        bootstrap,
                        materialize,
                        readSharedGatewayAccess,
                        registerLaunchEnvironmentTransformer,
                    }) => {
                        const sessionBindingMetadata =
                            bootstrap.sessionBindingMetadata;
                        if (!sessionBindingMetadata) {
                            throw new Error(
                                'Managed Provider binding metadata is unavailable',
                            );
                        }
                        const hostMaterialization = bootstrap.custody === 'daemonShared'
                            ? await createRunnerManagedProviderConsumerAccess({
                                signal: params.signal,
                                credentialTransport: bootstrap.scope.runtimeBindingBasis.runtimeCredentialTransport,
                                readAccess: readSharedGatewayAccess,
                                materialize,
                            })
                            : await managedServicesCustodyOwner
                                .materializeAdoptedProviderAgentBinding({
                                    materialize,
                                });
                        const cleanupHostMaterialization = 'cleanup' in hostMaterialization
                            && typeof hostMaterialization.cleanup === 'function'
                            ? hostMaterialization.cleanup : null;
                        try {
                            registerLaunchEnvironmentTransformer(
                                hostMaterialization
                                    .transformLaunchEnvironment,
                            );
                            runnerManagedServiceOwner
                                .registerAgentChildLaunchEnvironmentTransformer(
                                    hostMaterialization
                                        .transformLaunchEnvironment,
                                );
                            for (
                                const value
                                of hostMaterialization.redactionValues
                            ) {
                                invocationServiceOwners
                                    .registerRawForRedaction(seed, value);
                            }
                            const composed =
                                await composeProviderBindingMaterialization({
                                    materialization:
                                        hostMaterialization.materialization,
                                    materializationBaseDir: join(
                                        input.happyHomeDir,
                                        'providers',
                                        'materialized',
                                    ),
                                    sessionId: params.sessionId,
                                });
                            prepared = Object.freeze({
                                handoff: Object.freeze({
                                    v: 1 as const,
                                    materialization:
                                        composed.launchMaterialization,
                                    sessionBindingMetadata,
                                }),
                                environmentOverlay:
                                    composed.providerEnvironmentOverlay,
                                additionalRedactionValues:
                                    composed.additionalRedactionValues,
                                transformAgentChildLaunchEnvironment:
                                    hostMaterialization
                                        .transformLaunchEnvironment,
                                cleanup: (() => {
                                    const disposeComposed = composed.takeCleanupOwnership();
                                    return async () => {
                                        try { await disposeComposed?.(); }
                                        finally { await cleanupHostMaterialization?.(); }
                                    };
                                })(),
                            });
                        } catch (error) {
                            await cleanupHostMaterialization?.();
                            throw error;
                        }
                    },
                    local: localServices,
                });
                if (prepared) {
                    preparedManagedProviderPluginServices =
                        pluginServices;
                } else {
                    await dispatchCurrentRunnerDaemonPluginService({
                        authority: expectedAuthority,
                        operation: {
                            kind: 'plugin_services.close_v1',
                            requestId: randomUUID(),
                            invocationId: params.sessionId,
                        },
                    });
                }
                return prepared;
                })();
            }
            const attempt = preparedManagedProviderBindingPromise;
            try {
                return await attempt;
            } catch (error) {
                const code = error && typeof error === 'object'
                    ? Reflect.get(error, 'code')
                    : null;
                const provenBeforeEffect =
                    code === 'plugin_services_invocation_unavailable'
                    || classifyNativeAgentSessionEffectBoundaryError(error)
                        === 'authority_unavailable_before_effect';
                if (
                    provenBeforeEffect
                    && preparedManagedProviderBindingPromise === attempt
                ) {
                    preparedManagedProviderBindingPromise = null;
                    preparedManagedProviderPluginServices = null;
                }
                throw error;
            }
        },
        async createInvocationServices(params) {
            const invocationWitnessReader =
                params.readActiveTurnAdmissionWitness ?? null;
            readActiveTurnAdmissionWitness =
                invocationWitnessReader;
            params.signal.addEventListener('abort', () => {
                if (
                    readActiveTurnAdmissionWitness
                    === invocationWitnessReader
                ) {
                    readActiveTurnAdmissionWitness = null;
                }
            }, { once: true });
            if (preparedManagedProviderPluginServices) {
                return preparedManagedProviderPluginServices;
            }
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: params.pluginId,
                    version: params.pluginVersion,
                }),
                contribution: Object.freeze({
                    id: binding.localAgentId,
                    qualifiedId:
                        resolveAgentContributionQualifiedId({
                            pluginId: binding.pluginId,
                            localId: binding.localAgentId,
                        }),
                }),
                occurrenceId: runnerOccurrenceId,
                sourceCustody: binding.sourceCustody,
                correlationId: params.correlationId,
                surface: 'agent' as const,
                ...(params.session
                    ? {
                        session: Object.freeze({
                            id: params.session.id,
                        }),
                        currentSession: params.session.current,
                    }
                    : {}),
                signal: params.signal,
                ...(params.readActiveTurnAdmissionWitness
                    ? {
                        readActiveTurnAdmissionWitness:
                            params
                                .readActiveTurnAdmissionWitness,
                    }
                    : {}),
                isOccurrenceCurrent: params.isOccurrenceCurrent,
            });
            const localServices =
                invocationServiceOwners.createOperationServices(seed, {
                filesystemRoots: Object.freeze({
                    pluginData: join(
                        storePaths.storageDir,
                        params.pluginId,
                        'fs',
                    ),
                    workspace: params.cwd,
                    projects: new Map(),
                }),
                environment:
                    params.environment ?? Object.freeze({}),
                hostAccessRequests:
                    runnerManagedServiceOwner
                        .hostAccessRequests,
            });
            return await prepareRunnerDaemonPluginServices({
                invocationId: params.correlationId,
                signal: params.signal,
                dispatch: async (operation, options) =>
                    await dispatchCurrentRunnerDaemonPluginService({
                        authority: expectedAuthority,
                        operation,
                        ...(options?.timeoutMs !== undefined
                            ? {
                                timeoutMs:
                                    options.timeoutMs,
                            }
                            : {}),
                        ...(options?.signal
                            ? { signal: options.signal }
                            : {}),
                    }),
                isAuthorityTransitionError:
                    isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition,
                readManagedProviderRetention: () =>
                    managedServicesCustodyOwner
                        .readCurrentManagedProviderRetention(),
                bindManagedServices: (bindingInput) =>
                    runnerManagedServiceOwner.bindManagedServices({
                        seed,
                        agent: {
                            connectedAccounts:
                                bindingInput.connectedAccounts,
                            exec: bindingInput.exec,
                        },
                        managedProvider:
                            bindingInput.managedProvider,
                    }),
                ...(params.readActiveTurnAdmissionWitness
                    ? {
                        readActiveTurnAdmissionWitness:
                            params
                                .readActiveTurnAdmissionWitness,
                    }
                    : {}),
                local: localServices,
            });
        },
        async authorizeNewTurn(witness, options) {
            const response =
                await dispatchCurrentAgentRuntimeDaemonServiceRequest({
                    authority: expectedAuthority,
                    signal: options.signal,
                    createRequest: (capability) => ({
                        v: 1,
                        context: {
                            token: capability,
                            sessionId: authority.sessionId,
                        },
                        operation: {
                            kind: 'turn.admission.authorize',
                            requestId: witness.inputId,
                            witness: projectAgentRuntimeDaemonServiceTurnWitnessV1(
                                witness,
                            ),
                        },
                    }),
                });
            if (
                response.ok
                && response.result.kind === 'turn.admission'
                && response.result.status === 'admitted'
                && response.result.witness.inputId === witness.inputId
                && response.result.witness.turnId === witness.turnId
                && response.result.witness.userMessageSeq
                    === witness.userMessageSeq
                && JSON.stringify(
                    response.result.witness.userMessageSeqs,
                ) === JSON.stringify(witness.userMessageSeqs)
            ) {
                return Object.freeze({
                    status: 'admitted' as const,
                });
            }
            throw createNativeAgentSessionEffectBoundaryError(
                'authority_unavailable_before_effect',
            );
        },
        async attestSessionOpen(params) {
            await attestCurrentRunnerAgentSessionOpen({
                authority: expectedAuthority,
                requestId: randomUUID(),
                phase: params.phase,
                request:
                    AgentRuntimeDaemonSessionOpenRequestV1Schema
                        .parse(params.request),
                providerSessionId:
                    params.providerSessionId,
                signal: params.signal,
            });
        },
        managedProviderRunServices: createCurrentRunnerManagedProviderRunServices(expectedAuthority),
        async prepareTeamCredentialProviderBinding(params) {
            const result = await openCurrentRunnerTeamCredentialProviderBinding({
                authority: expectedAuthority,
                operation: {
                    kind: 'provider_broker.binding.open',
                    resourceId: params.resourceId,
                    expectedResourceRevision: params.expectedResourceRevision,
                    agentTargetKey: params.agentTargetKey,
                    modelId: params.modelId,
                    ...(params.consumer ? { consumer: params.consumer } : {}),
                    ...(params.executionRunSelection
                        ? {
                            teamId: params.executionRunSelection.teamId,
                            deliveryMode: params.executionRunSelection.deliveryMode,
                        }
                        : {}),
                    ...(params.executionRunAgentId ? { agentId: params.executionRunAgentId } : {}),
                },
                signal: params.signal,
            });
            const bindingId = result.bindingId;
            return {
                providerBinding: result.providerBinding,
                environmentOverlay: result.environmentOverlay,
                additionalRedactionValues: result.additionalRedactionValues,
                ...(bindingId
                    ? {
                        cleanup: async () => {
                            await closeCurrentRunnerTeamCredentialProviderBinding({
                                authority: expectedAuthority,
                                operation: {
                                    kind: 'provider_broker.binding.close',
                                    bindingId,
                                },
                            });
                        },
                    }
                    : {}),
            };
        },
        prepareRuntimeFactory: prepareRuntimeLeaf,
        retire: retireSource,
        daemonTurnContributionsBridge,
        daemonModelTransitionAuthorizer,
        externalSessionHostOperations:
            daemonFacets.externalSessionHostOperations,
        retainedExternalSessionProviderOps,
        managedServiceEndpointReadPort:
            runnerManagedServiceOwner.endpointReadPort,
        resolveProviderCliAttachManagedServiceAccess:
            runnerManagedServiceOwner.resolveProviderCliAttachManagedServiceAccess,
        managedServicesCustodyPort:
            managedServicesCustodyOwner,
        agentSessionRealtimeVoiceAuthority:
            daemonFacets.agentSessionRealtimeVoiceAuthority,
    });
}
