import { loadPluginDaemonModule } from '../../../plugins/runtime/loadPluginDaemonModule';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginDaemonModuleNamespace, PluginHookHandler } from '../../../plugins/runtime/types';
import type { PluginCompatibilityDiagnostic } from '../../../plugins/validation/diagnostics/types';
import { buildBackendSurfaceDispatchKey } from '../../../plugins/manifest/adapters';
import type {
    AnyTerminalRuntimeOps,
    ProviderAttachOps,
    ProviderAttachEligibility,
    ProviderAttachScope,
} from '@/agent/catalog/types';
import {
    parseCheckpointAvailabilityRequestV1,
    parseCreateCheckpointRequestV1,
    parseResolveCheckpointRestoreTargetRequestV1,
    parseRestoreCheckpointRequestV1,
} from '@happier-dev/agents';
import type {
    AttachResultV1,
    CheckpointSurfaceV1,
    ExternalSessionActivityResultV1,
    ExternalSessionAvailabilityOperationV1,
    ExternalSessionCandidatePageV1,
    ExternalSessionFollowLeaseV1,
    ExternalSessionFollowTranscriptPathResolutionV1,
    ExternalSessionResolvedIdentityV1,
    ExternalSessionResolveSourceResultV1,
    ExternalSessionRuntimeContextV1,
    ExternalSessionTakeoverLaunchResultV1,
    ExternalSessionTranscriptPageV1,
    ForkSurfaceV1,
    HandoffSurfaceV1,
} from '@happier-dev/agents';
import {
    ExternalSessionProviderFailureError,
    type ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedBackendSurfaceContribution,
    ResolvedAgentContribution,
} from '../../../plugins/projection/registry/types';
import type {
    BackendSurfaceAvailabilityV1,
    BackendSurfaceDeclarationV1,
} from '@happier-dev/protocol';
import { BackendSurfaceOperationCatalogV1 as BACKEND_SURFACE_OPERATION_CATALOG_V1 } from '@happier-dev/protocol';

import {
    createEmptyBackendExecutionSurfaces,
    type BackendExecutionSurfaces,
    type EngineResolutionDiagnostic,
} from './engineRegistryTypes';
import { evaluateBackendSurfaceAvailability } from './backendSurfaceAvailability';
import { mapExternalSessionLaunchHintsToSpawnOptions } from './externalSessionLaunchHints';

function appendPluginDiagnostics(
    diagnostics: EngineResolutionDiagnostic[],
    backend: ResolvedAgentRuntimeContribution,
    provider: ResolvedAgentContribution,
    pluginDiagnostics: readonly PluginCompatibilityDiagnostic[],
): void {
    const runtimeOwnerId = provider.id;
    for (const diagnostic of pluginDiagnostics) {
        diagnostics.push({
            code: 'engine_plugin_registry_diagnostic',
            message: diagnostic.message,
            detailCode: diagnostic.code,
            backendId: backend.id,
            providerId: runtimeOwnerId,
            pluginId: backend.pluginId,
        });
    }
}

function resolvePluginBackendSurfaceHandlerExport(
    moduleNamespace: PluginDaemonModuleNamespace,
    exportName?: string,
): Readonly<
    | { status: 'found'; handler: PluginHookHandler }
    | { status: 'missing' }
    | { status: 'invalid' }
> {
    if (exportName) {
        const directExport = moduleNamespace[exportName];
        if (typeof directExport === 'function') {
            return { status: 'found', handler: directExport as PluginHookHandler };
        }
        if (directExport !== undefined) {
            return { status: 'invalid' };
        }

        const defaultExport = moduleNamespace.default;
        if (defaultExport && typeof defaultExport === 'object') {
            const nestedExport = (defaultExport as Record<string, unknown>)[exportName];
            if (typeof nestedExport === 'function') {
                return { status: 'found', handler: nestedExport as PluginHookHandler };
            }
            if (nestedExport !== undefined) {
                return { status: 'invalid' };
            }
        }
        return { status: 'missing' };
    }

    if (typeof moduleNamespace.default === 'function') {
        return { status: 'found', handler: moduleNamespace.default as PluginHookHandler };
    }

    return moduleNamespace.default === undefined ? { status: 'missing' } : { status: 'invalid' };
}

export function resolveBackendExecutionSurfacesFromHandlers(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
    backend: ResolvedAgentRuntimeContribution,
    params?: Readonly<{
        resolveExternalSessionRuntimeContext?: ExternalSessionRuntimeContextResolver;
        grantExternalSessionTranscriptPath?: ExternalSessionTranscriptPathGrantIssuer;
        runExternalSessionFollowWithLinkedSession?: ExternalSessionFollowScopeRunner;
    }>,
): BackendExecutionSurfaces {
    const terminalRuntime = resolveTerminalRuntimeOps(handlerBySurfaceOperation);
    const externalSession = resolveExternalSessionProviderOps(handlerBySurfaceOperation, backend, params);
    const attach = resolveProviderAttachOps(handlerBySurfaceOperation);
    const handoff = resolveHandoffProviderOps(handlerBySurfaceOperation);
    const fork = resolveProviderForkOps(handlerBySurfaceOperation);
    const checkpoint = resolveCheckpointOps(handlerBySurfaceOperation);

    return {
        terminalRuntime,
        externalSession,
        attach,
        handoff,
        fork,
        checkpoint,
    };
}

function readBackendSurfaceHandler(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
    kind: BackendSurfaceDeclarationV1['kind'],
    operation: BackendSurfaceDeclarationV1['operation'],
): PluginHookHandler | undefined {
    return handlerBySurfaceOperation.get(buildBackendSurfaceDispatchKey({
        kind,
        operation,
    }));
}

type ExternalValidateSource = NonNullable<ExternalSessionExecutionSurface['validateSource']>;
type ExternalListCandidates = NonNullable<ExternalSessionExecutionSurface['listCandidates']>;
type ExternalGetActivity = NonNullable<ExternalSessionExecutionSurface['getActivity']>;
type ExternalPageTranscript = NonNullable<ExternalSessionExecutionSurface['pageTranscript']>;
type ExternalReadAfterTranscript = NonNullable<ExternalSessionExecutionSurface['readAfterTranscript']>;
type ExternalResolveFollowTranscriptPath = NonNullable<ExternalSessionExecutionSurface['resolveFollowTranscriptPath']>;
type ExternalResolveTakeoverSpawnOptions = NonNullable<ExternalSessionExecutionSurface['resolveTakeoverSpawnOptions']>;
type ExternalAcquireFollowLease = NonNullable<ExternalSessionExecutionSurface['acquireFollowLease']>;
type ExternalCanonicalizeLinkedSession = NonNullable<ExternalSessionExecutionSurface['canonicalizeLinkedSession']>;
type ExternalResolveLinkIdentity = NonNullable<ExternalSessionExecutionSurface['resolveLinkIdentity']>;
type ExternalSessionRuntimeContextResolver = (
    request: Readonly<{
        operation: ExternalSessionAvailabilityOperationV1;
        source?: import('@happier-dev/protocol').ExternalSessionsSource;
        providerSessionId?: string;
        linkedSessionId?: string;
        directory?: string;
    }>,
) => ExternalSessionRuntimeContextV1 | null | Promise<ExternalSessionRuntimeContextV1 | null>;
type ExternalSessionTranscriptPathGrantIssuer = (
    request: Readonly<{
        path: string;
        source: import('@happier-dev/protocol').ExternalSessionsSource;
        providerSessionId: string;
        sourceId?: string;
        sessionId?: string | null;
    }>,
) => void | Promise<void>;
type ExternalSessionFollowScopeRunner = <T>(
    sessionId: string | null,
    operation: () => Promise<T>,
) => Promise<T>;

function failBackendSurfaceResult(operation: string, result: Readonly<{
    code?: string;
    message?: string;
    retryable?: boolean;
}>): never {
    const reason = result.message ?? result.code ?? 'unavailable';
    if (operation.startsWith('externalSession.')) {
        throw new ExternalSessionProviderFailureError({
            operation,
            code: result.code ?? 'agent_unavailable',
            message: reason,
            retryable: result.retryable,
        });
    }
    throw new Error(`Backend surface operation '${operation}' failed: ${reason}`);
}

async function unwrapBackendSurfaceResult<TValue>(
    operation: string,
    result: unknown,
): Promise<TValue> {
    const settled = await result;
    if (!settled || typeof settled !== 'object' || Array.isArray(settled) || !('ok' in settled)) {
        throw new Error(`Backend surface operation '${operation}' returned a non-result payload`);
    }
    const record = settled as Readonly<Record<string, unknown>>;
    if (record.ok !== true) {
        failBackendSurfaceResult(operation, {
            code: typeof record.code === 'string' ? record.code : undefined,
            message: typeof record.message === 'string' ? record.message : undefined,
            retryable: record.retryable === true,
        });
    }
    if (!('value' in record)) {
        throw new Error(`Backend surface operation '${operation}' returned an ok result without value`);
    }
    return record.value as TValue;
}

async function unwrapTakeoverLaunchResult(
    operation: string,
    result: unknown,
): Promise<ExternalSessionTakeoverLaunchResultV1 | null> {
    const settled = await result;
    if (!settled || typeof settled !== 'object' || Array.isArray(settled) || !('ok' in settled)) {
        throw new Error(`Backend surface operation '${operation}' returned a non-result payload`);
    }
    const record = settled as Readonly<Record<string, unknown>>;
    if (record.ok !== true) {
        if (record.code === 'takeover_not_available') {
            return null;
        }
        failBackendSurfaceResult(operation, {
            code: typeof record.code === 'string' ? record.code : undefined,
            message: typeof record.message === 'string' ? record.message : undefined,
            retryable: record.retryable === true,
        });
    }
    if (!('value' in record)) {
        throw new Error(`Backend surface operation '${operation}' returned an ok result without value`);
    }
    return record.value as ExternalSessionTakeoverLaunchResultV1;
}

function resolveLegacyAttachScope(params: Parameters<ProviderAttachOps['evaluateAvailability']>[0]): ProviderAttachScope {
    if (params.hasLocalAttachmentInfo) {
        return 'local';
    }
    if (params.currentMachineId && params.sessionMachineId && params.currentMachineId === params.sessionMachineId) {
        return 'local';
    }
    return 'remote';
}

function mapAvailabilityToLegacyAttachEligibility(
    params: Parameters<ProviderAttachOps['evaluateAvailability']>[0],
    availability: BackendSurfaceAvailabilityV1,
): ProviderAttachEligibility {
    if (!availability.available) {
        return {
            eligible: false,
            reason: availability.reasonCode ?? 'unavailable',
        };
    }
    return {
        eligible: true,
        scope: resolveLegacyAttachScope(params),
        metadata: params.metadata,
    };
}

function resolveSurfaceHandlerDefinition(
    surfaceHandler: ResolvedBackendSurfaceContribution,
): BackendSurfaceDeclarationV1 {
    return surfaceHandler.definition;
}

function resolveTerminalRuntimeOps(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
): AnyTerminalRuntimeOps | null {
    const launch = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'terminalRuntime',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.terminalRuntime.launch,
    );
    const evaluateAvailability = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'terminalRuntime',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.terminalRuntime.evaluateAvailability,
    );
    const discoverIdentity = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'terminalRuntime',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.terminalRuntime.discoverIdentity,
    );
    const transcriptBinding = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'terminalRuntime',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.terminalRuntime.resolveTranscriptBinding,
    );

    if (!evaluateAvailability && !launch && !discoverIdentity && !transcriptBinding) {
        return null;
    }

    return {
        ...(evaluateAvailability
            ? {
                evaluateAvailability: ((request) => (
                    evaluateBackendSurfaceAvailability(
                        evaluateAvailability as NonNullable<AnyTerminalRuntimeOps['evaluateAvailability']>,
                        request,
                    )
                )) satisfies NonNullable<AnyTerminalRuntimeOps['evaluateAvailability']>,
            }
            : {}),
        ...(launch
            ? {
                launch: launch as AnyTerminalRuntimeOps['launch'],
            }
            : {}),
        ...(discoverIdentity
            ? {
                discoverIdentity: discoverIdentity as AnyTerminalRuntimeOps['discoverIdentity'],
            }
            : {}),
        ...(transcriptBinding
            ? {
                resolveTranscriptBinding: transcriptBinding as AnyTerminalRuntimeOps['resolveTranscriptBinding'],
            }
            : {}),
    };
}

function resolveExternalSessionProviderOps(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
    backendContribution: ResolvedAgentRuntimeContribution,
    params?: Readonly<{
        resolveExternalSessionRuntimeContext?: ExternalSessionRuntimeContextResolver;
        grantExternalSessionTranscriptPath?: ExternalSessionTranscriptPathGrantIssuer;
        runExternalSessionFollowWithLinkedSession?: ExternalSessionFollowScopeRunner;
    }>,
): ExternalSessionExecutionSurface | null {
    const validateSource = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.resolveSource,
    );
    const evaluateAvailability = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.evaluateAvailability,
    );
    const listCandidates = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.listCandidates,
    );
    const getActivity = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.getActivity,
    );
    const pageTranscript = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.pageTranscript,
    );
    const readAfterTranscript = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.readAfterTranscript,
    );
    const resolveFollowTranscriptPath = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.resolveFollowTranscriptPath,
    );
    const resolveTakeoverSpawnOptions = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.resolveTakeoverLaunch,
    );

    const acquireFollowLease = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.acquireFollowLease,
    );
    const canonicalizeLinkedSession = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.resolveLinkedIdentity,
    );
    const resolveLinkIdentity = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'externalSession',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.externalSession.resolveLinkIdentity,
    );

    const surface: ExternalSessionExecutionSurface = {
        ...(evaluateAvailability
            ? {
                evaluateAvailability: ((request) => (
                    evaluateBackendSurfaceAvailability(
                        evaluateAvailability as NonNullable<ExternalSessionExecutionSurface['evaluateAvailability']>,
                        request,
                    )
                )) satisfies NonNullable<ExternalSessionExecutionSurface['evaluateAvailability']>,
            }
            : {}),
        ...(validateSource
            ? {
                validateSource: async (request: Parameters<ExternalValidateSource>[0]) => {
                    const value = await unwrapBackendSurfaceResult<ExternalSessionResolveSourceResultV1>(
                        'externalSession.resolveSource',
                        validateSource({
                            source: request.source,
                            ...(request.env ? { env: request.env } : {}),
                            ...(request.runtime ? { runtime: request.runtime } : {}),
                        }),
                    );
                    return {
                        ok: true as const,
                        source: value.source,
                    };
                },
            }
            : {}),
        ...(listCandidates
            ? {
                listCandidates: async (request: Parameters<ExternalListCandidates>[0]) => {
                    const value = await unwrapBackendSurfaceResult<ExternalSessionCandidatePageV1>(
                        'externalSession.listCandidates',
                        listCandidates(request),
                    );
                    return {
                        candidates: [...value.candidates],
                        nextCursor: value.nextCursor,
                        ...(value.searchIncomplete ? { searchIncomplete: true as const } : {}),
                    };
                },
            }
            : {}),
        ...(getActivity
            ? {
                getActivity: async (request: Parameters<ExternalGetActivity>[0]) => {
                    return await unwrapBackendSurfaceResult<ExternalSessionActivityResultV1>(
                        'externalSession.getActivity',
                        getActivity({
                            source: request.source,
                            providerSessionId: request.remoteSessionId,
                        }),
                    );
                },
            }
            : {}),
        ...(pageTranscript
            ? {
                pageTranscript: async (request: Parameters<ExternalPageTranscript>[0]) => {
                    const value = await unwrapBackendSurfaceResult<ExternalSessionTranscriptPageV1>(
                        'externalSession.pageTranscript',
                        pageTranscript({
                            source: request.source,
                            providerSessionId: request.remoteSessionId,
                            direction: request.direction,
                            cursor: request.cursor,
                            maxBytes: request.maxBytes,
                            maxItems: request.maxItems,
                        }),
                    );
                    return {
                        items: [...value.items],
                        nextCursor: value.nextCursor,
                        tailCursor: value.tailCursor ?? null,
                        hasMore: value.hasMore === true,
                        truncated: value.truncated === true,
                    };
                },
            }
            : {}),
        ...(readAfterTranscript
            ? {
                readAfterTranscript: async (request: Parameters<ExternalReadAfterTranscript>[0]) => {
                    const value = await unwrapBackendSurfaceResult<ExternalSessionTranscriptPageV1>(
                        'externalSession.readAfterTranscript',
                        readAfterTranscript({
                            source: request.source,
                            providerSessionId: request.remoteSessionId,
                            cursor: request.cursor,
                            maxBytes: request.maxBytes,
                            maxItems: request.maxItems,
                        }),
                    );
                    return {
                        items: [...value.items],
                        nextCursor: value.nextCursor,
                        truncated: value.truncated === true,
                    };
                },
            }
            : {}),
        ...(resolveFollowTranscriptPath
            ? {
                resolveFollowTranscriptPath: async (request: Parameters<ExternalResolveFollowTranscriptPath>[0]) => {
                    const runtime = request.runtime ?? await params?.resolveExternalSessionRuntimeContext?.({
                        operation: 'resolveFollowTranscriptPath',
                        source: request.source,
                        providerSessionId: request.remoteSessionId,
                        linkedSessionId: request.linkedSessionId,
                    }) ?? null;
                    const value = await unwrapBackendSurfaceResult<ExternalSessionFollowTranscriptPathResolutionV1>(
                        'externalSession.resolveFollowTranscriptPath',
                        resolveFollowTranscriptPath({
                            source: request.source,
                            providerSessionId: request.remoteSessionId,
                            reason: request.reason,
                            ...(request.linkedSessionId ? { linkedSessionId: request.linkedSessionId } : {}),
                            ...(runtime ? { runtime } : {}),
                        }),
                    );
                    return {
                        path: value.path,
                        ...(typeof value.sourceId === 'string' && value.sourceId.trim().length > 0
                            ? { sourceId: value.sourceId.trim() }
                            : {}),
                    };
                },
            }
            : {}),
        ...(resolveTakeoverSpawnOptions
            ? {
                resolveTakeoverSpawnOptions: async (request: Parameters<ExternalResolveTakeoverSpawnOptions>[0]) => {
                    const value = await unwrapTakeoverLaunchResult(
                        'externalSession.resolveTakeoverLaunch',
                        resolveTakeoverSpawnOptions({
                            linkedSessionId: request.sessionId,
                            providerSessionId: request.linked.remoteSessionId,
                            source: request.linked.source,
                            metadata: request.linked.metadata,
                        }),
                    );
                    if (!value) {
                        return null;
                    }
                    return mapExternalSessionLaunchHintsToSpawnOptions({
                        backend: backendContribution,
                        hints: value.launch,
                        linked: request.linked,
                        sessionId: request.sessionId,
                        fallbackDirectory: request.linked.sessionPath,
                    });
                },
            }
            : {}),
        ...(acquireFollowLease
            ? {
                acquireFollowLease: async (request: Parameters<ExternalAcquireFollowLease>[0]) => {
                    const runtime = request.runtime ?? await params?.resolveExternalSessionRuntimeContext?.({
                        operation: 'acquireFollowLease',
                        source: request.source,
                        providerSessionId: request.remoteSessionId,
                        linkedSessionId: request.linkedSessionId,
                    }) ?? null;
                    const sessionId = typeof runtime?.session?.sessionId === 'string' && runtime.session.sessionId.trim().length > 0
                        ? runtime.session.sessionId.trim()
                        : request.linkedSessionId ?? null;
                    if (params?.grantExternalSessionTranscriptPath) {
                        if (!resolveFollowTranscriptPath) {
                            throw new Error('Backend external-session file-follow acquisition requires externalSession.resolveFollowTranscriptPath');
                        }
                        const pathResolution = await unwrapBackendSurfaceResult<ExternalSessionFollowTranscriptPathResolutionV1>(
                            'externalSession.resolveFollowTranscriptPath',
                            resolveFollowTranscriptPath({
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                                reason: request.reason,
                                ...(request.linkedSessionId ? { linkedSessionId: request.linkedSessionId } : {}),
                                ...(runtime ? { runtime } : {}),
                            }),
                        );
                        await params.grantExternalSessionTranscriptPath({
                            path: pathResolution.path,
                            source: request.source,
                            providerSessionId: request.remoteSessionId,
                            ...(typeof pathResolution.sourceId === 'string' && pathResolution.sourceId.trim().length > 0
                                ? { sourceId: pathResolution.sourceId.trim() }
                                : {}),
                            sessionId,
                        });
                    }
                    const acquire = async () => await unwrapBackendSurfaceResult<ExternalSessionFollowLeaseV1>(
                        'externalSession.acquireFollowLease',
                        acquireFollowLease({
                            source: request.source,
                            providerSessionId: request.remoteSessionId,
                            reason: request.reason,
                            ...(request.linkedSessionId ? { linkedSessionId: request.linkedSessionId } : {}),
                            ...(runtime ? { runtime } : {}),
                        }),
                    );
                    return params?.runExternalSessionFollowWithLinkedSession
                        ? await params.runExternalSessionFollowWithLinkedSession(sessionId, acquire)
                        : await acquire();
                },
            }
            : {}),
        ...(canonicalizeLinkedSession
            ? {
                canonicalizeLinkedSession: async (request: Parameters<ExternalCanonicalizeLinkedSession>[0]) => {
                    const value = await unwrapBackendSurfaceResult<ExternalSessionResolvedIdentityV1>(
                        'externalSession.resolveLinkedIdentity',
                        canonicalizeLinkedSession({
                            metadata: request.metadata,
                            providerSessionId: request.remoteSessionId,
                            source: request.source,
                        }),
                    );
                    return {
                        remoteSessionId: value.providerSessionId,
                        source: value.source,
                        runtimeDescriptor: value.runtimeDescriptor ?? null,
                        vendorMetadata: value.vendorMetadata,
                        externalSessionMetadata: value.externalSessionMetadata,
                        sessionStateUpdates: value.sessionStateUpdates,
                    };
                },
            }
            : {}),
        ...(resolveLinkIdentity
            ? {
                resolveLinkIdentity: async (request: Parameters<ExternalResolveLinkIdentity>[0]) => {
                    const value = await unwrapBackendSurfaceResult<ExternalSessionResolvedIdentityV1>(
                        'externalSession.resolveLinkIdentity',
                        resolveLinkIdentity({
                            providerSessionId: request.remoteSessionId,
                            source: request.source,
                            runtimeDescriptor: request.runtimeDescriptor,
                            metadata: request.metadata,
                        }),
                    );
                    return {
                        remoteSessionId: value.providerSessionId,
                        source: value.source,
                        runtimeDescriptor: value.runtimeDescriptor ?? null,
                        vendorMetadata: value.vendorMetadata,
                        externalSessionMetadata: value.externalSessionMetadata,
                        sessionStateUpdates: value.sessionStateUpdates,
                    };
                },
            }
            : {}),
    };
    return Object.keys(surface).length > 0 ? surface : null;
}

function resolveProviderAttachOps(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
): ProviderAttachOps | null {
    const availability = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'attach',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.attach.evaluateAvailability,
    );
    const attach = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'attach',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.attach.attach,
    );

    if (!availability || !attach) {
        return null;
    }

    return {
        evaluateAvailability: async (request) => {
            const result = await evaluateBackendSurfaceAvailability(
                availability as (input: Readonly<{
                    operation: 'attach';
                    sessionId: string;
                    metadata: Readonly<Record<string, unknown>>;
                    currentMachineId: string | null;
                    sessionMachineId: string | null;
                    hasLocalAttachmentInfo: boolean;
                    depth: 'metadata';
                }>) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>,
                {
                    operation: 'attach',
                    sessionId: request.sessionId,
                    metadata: request.metadata,
                    currentMachineId: request.currentMachineId,
                    sessionMachineId: request.sessionMachineId,
                    hasLocalAttachmentInfo: request.hasLocalAttachmentInfo,
                    depth: 'metadata',
                },
            );
            return mapAvailabilityToLegacyAttachEligibility(request, result as BackendSurfaceAvailabilityV1);
        },
        attach: async (request) => {
            const result = await unwrapBackendSurfaceResult<AttachResultV1>(
                'attach.attach',
                attach({
                    sessionId: request.sessionId,
                    metadata: request.metadata,
                }),
            );
            return typeof result.exitCode === 'number' ? result.exitCode : false;
        },
    };
}

function resolveHandoffProviderOps(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
): HandoffSurfaceV1 | null {
    const evaluateAvailability = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'handoff',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.handoff.evaluateAvailability,
    );
    const exportBundle = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'handoff',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.handoff.exportBundle,
    );
    const importBundle = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'handoff',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.handoff.importBundle,
    );

    if (!exportBundle || !importBundle) {
        return null;
    }

    return {
        ...(evaluateAvailability
            ? {
                evaluateAvailability: ((request) => (
                    evaluateBackendSurfaceAvailability(
                        evaluateAvailability as NonNullable<HandoffSurfaceV1['evaluateAvailability']>,
                        request,
                    )
                )) satisfies NonNullable<HandoffSurfaceV1['evaluateAvailability']>,
            }
            : {}),
        exportBundle: exportBundle as HandoffSurfaceV1['exportBundle'],
        importBundle: importBundle as HandoffSurfaceV1['importBundle'],
    };
}

function resolveProviderForkOps(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
): ForkSurfaceV1 | null {
    const evaluateAvailability = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'fork',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.fork.evaluateAvailability,
    );
    const fork = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'fork',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.fork.fork,
    );
    const replayChildLaunch = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'fork',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.fork.resolveReplayChildLaunch,
    );

    if (!evaluateAvailability && !fork && !replayChildLaunch) {
        return null;
    }

    return {
        ...(evaluateAvailability
            ? {
                evaluateAvailability: ((request) => (
                    evaluateBackendSurfaceAvailability(
                        evaluateAvailability as NonNullable<ForkSurfaceV1['evaluateAvailability']>,
                        request,
                    )
                )) satisfies NonNullable<ForkSurfaceV1['evaluateAvailability']>,
            }
            : {}),
        ...(fork
            ? {
                fork: fork as ForkSurfaceV1['fork'],
            }
            : {}),
        ...(replayChildLaunch
            ? {
                resolveReplayChildLaunch: replayChildLaunch as ForkSurfaceV1['resolveReplayChildLaunch'],
            }
            : {}),
    };
}

function resolveCheckpointOps(
    handlerBySurfaceOperation: ReadonlyMap<string, PluginHookHandler>,
): CheckpointSurfaceV1 | null {
    const evaluateAvailability = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'checkpoint',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.checkpoint.evaluateAvailability,
    );
    const list = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'checkpoint',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.checkpoint.list,
    );
    const resolveRestoreTarget = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'checkpoint',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.checkpoint.resolveRestoreTarget,
    );
    const checkpoint = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'checkpoint',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.checkpoint.checkpoint,
    );
    const restore = readBackendSurfaceHandler(
        handlerBySurfaceOperation,
        'checkpoint',
        BACKEND_SURFACE_OPERATION_CATALOG_V1.checkpoint.restore,
    );

    if (!evaluateAvailability && !list && !resolveRestoreTarget && !checkpoint && !restore) {
        return null;
    }

    return {
        ...(evaluateAvailability
            ? {
                evaluateAvailability: ((request) => (
                    evaluateBackendSurfaceAvailability(
                        evaluateAvailability as NonNullable<CheckpointSurfaceV1['evaluateAvailability']>,
                        parseCheckpointAvailabilityRequestV1(request),
                    )
                )) as CheckpointSurfaceV1['evaluateAvailability'],
            }
            : {}),
        ...(list
            ? {
                list: list as CheckpointSurfaceV1['list'],
            }
            : {}),
        ...(resolveRestoreTarget
            ? {
                resolveRestoreTarget: ((request) => (
                    resolveRestoreTarget(parseResolveCheckpointRestoreTargetRequestV1(request))
                )) as CheckpointSurfaceV1['resolveRestoreTarget'],
            }
            : {}),
        ...(checkpoint
            ? {
                checkpoint: ((request) => (
                    checkpoint(parseCreateCheckpointRequestV1(request))
                )) as CheckpointSurfaceV1['checkpoint'],
            }
            : {}),
        ...(restore
            ? {
                restore: ((request) => (
                    restore(parseRestoreCheckpointRequestV1(request))
                )) as CheckpointSurfaceV1['restore'],
            }
            : {}),
    };
}

export async function resolvePluginBackendSurfaceHandlers(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    engineImplementedBackendSurfaceOperations?: ReadonlySet<string>;
    resolveExternalSessionRuntimeContext?: ExternalSessionRuntimeContextResolver;
    grantExternalSessionTranscriptPath?: ExternalSessionTranscriptPathGrantIssuer;
    runExternalSessionFollowWithLinkedSession?: ExternalSessionFollowScopeRunner;
}>): Promise<Readonly<{
    surfaces: BackendExecutionSurfaces;
    diagnostics: readonly EngineResolutionDiagnostic[];
}>> {
    const { backend, provider, runtimeRegistry } = params;
    const runtimeOwnerId = provider.id;
    const diagnostics: EngineResolutionDiagnostic[] = [];
    if (backend.pluginId) {
        appendPluginDiagnostics(
            diagnostics,
            backend,
            provider,
            runtimeRegistry.pluginDiagnosticsByPluginId[backend.pluginId] ?? [],
        );
    }

    const staticSurfaceHandlers = (runtimeRegistry.contributes.surfaceHandlersByBackendId.get(backend.id) ?? [])
        .filter((surfaceHandler) => resolveSurfaceHandlerDefinition(surfaceHandler).support !== 'unsupported');
    const surfaceHandlers = staticSurfaceHandlers.filter((surfaceHandler) => {
        const surfaceHandlerDefinition = resolveSurfaceHandlerDefinition(surfaceHandler);
        return !params.engineImplementedBackendSurfaceOperations?.has(buildBackendSurfaceDispatchKey({
            kind: surfaceHandlerDefinition.kind,
            operation: surfaceHandlerDefinition.operation,
        }));
    });
    const activatedHandlers = runtimeRegistry.runtimeCoreHandlersByBackendId.get(backend.id);

    const handlerBySurfaceOperation = new Map<string, PluginHookHandler>();
    if (activatedHandlers && activatedHandlers.size > 0) {
        for (const [surfaceOperationKey, handler] of activatedHandlers.entries()) {
            handlerBySurfaceOperation.set(surfaceOperationKey, handler);
        }
    }

    if (surfaceHandlers.length > 0) {
        if (!backend.daemonEntryPath) {
            diagnostics.push({
                code: 'engine_plugin_daemon_entry_missing',
                message: `Backend '${backend.id}' has no daemon entry path`,
                backendId: backend.id,
                providerId: runtimeOwnerId,
                pluginId: backend.pluginId,
            });
        } else if (surfaceHandlers.some((surfaceHandler) => resolveSurfaceHandlerDefinition(surfaceHandler).handler.target !== 'daemon')) {
            diagnostics.push({
                code: 'engine_plugin_backend_surface_non_daemon_target',
                message: `Backend '${backend.id}' backend surface handlers must target daemon handlers only`,
                backendId: backend.id,
                providerId: runtimeOwnerId,
                pluginId: backend.pluginId,
            });
        } else {
            const missingSurfaceHandlers = surfaceHandlers.filter((surfaceHandler) => {
                const surfaceHandlerDefinition = resolveSurfaceHandlerDefinition(surfaceHandler);
                return !handlerBySurfaceOperation.has(buildBackendSurfaceDispatchKey({
                    kind: surfaceHandlerDefinition.kind,
                    operation: surfaceHandlerDefinition.operation,
                }));
            });
            if (missingSurfaceHandlers.length === 0) {
                const surfaces = resolveBackendExecutionSurfacesFromHandlers(handlerBySurfaceOperation, backend, {
                    resolveExternalSessionRuntimeContext: params.resolveExternalSessionRuntimeContext,
                    grantExternalSessionTranscriptPath: params.grantExternalSessionTranscriptPath,
                    runExternalSessionFollowWithLinkedSession: params.runExternalSessionFollowWithLinkedSession,
                });
                return {
                    surfaces,
                    diagnostics: Object.freeze(diagnostics),
                };
            }

            let moduleNamespace: PluginDaemonModuleNamespace | null = null;
            try {
                moduleNamespace = await loadPluginDaemonModule({
                    daemonEntryPath: backend.daemonEntryPath,
                    devDaemonEntryPath: backend.devDaemonEntryPath,
                    cacheKey: backend.manifestDigest,
                    trustPolicy: backend.sourceSpec?.trustPolicy,
                });
            } catch (error) {
                const errorCode = error instanceof Error ? String((error as Error & { code?: string }).code ?? '') : '';
                diagnostics.push({
                    code: 'engine_plugin_daemon_module_load_failed',
                    message: error instanceof Error ? error.message : `Failed to load daemon module for backend '${backend.id}'`,
                    backendId: backend.id,
                    providerId: runtimeOwnerId,
                    pluginId: backend.pluginId,
                    detailCode:
                        errorCode === 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED'
                            ? 'plugin_trust_approval_required'
                            : errorCode === 'PLUGIN_DAEMON_TRUST_UNTRUSTED'
                                ? 'plugin_untrusted'
                                : undefined,
                });
            }

            if (moduleNamespace) {
                for (const surfaceHandler of missingSurfaceHandlers) {
                    const surfaceHandlerDefinition = resolveSurfaceHandlerDefinition(surfaceHandler);
                    const resolvedExport = resolvePluginBackendSurfaceHandlerExport(
                        moduleNamespace,
                        surfaceHandlerDefinition.handler.exportName,
                    );
                    if (resolvedExport.status === 'found') {
                        handlerBySurfaceOperation.set(buildBackendSurfaceDispatchKey({
                            kind: surfaceHandlerDefinition.kind,
                            operation: surfaceHandlerDefinition.operation,
                        }), resolvedExport.handler);
                        continue;
                    }
                    diagnostics.push({
                        code: resolvedExport.status === 'missing'
                            ? 'engine_plugin_backend_surface_handler_missing'
                            : 'engine_plugin_backend_surface_handler_invalid',
                        message: `Backend '${backend.id}' backend surface handler '${surfaceHandlerDefinition.id}' (${surfaceHandlerDefinition.kind}:${surfaceHandlerDefinition.operation}) export '${surfaceHandlerDefinition.handler.exportName ?? 'default'}' ${resolvedExport.status}`,
                        backendId: backend.id,
                        providerId: runtimeOwnerId,
                        pluginId: backend.pluginId,
                    });
                }
            }
        }
    }

    if (handlerBySurfaceOperation.size === 0) {
        if (
            staticSurfaceHandlers.length === 0
            && (!activatedHandlers || activatedHandlers.size === 0)
            && (!params.engineImplementedBackendSurfaceOperations || params.engineImplementedBackendSurfaceOperations.size === 0)
        ) {
            diagnostics.push({
                code: 'engine_plugin_backend_surface_missing',
                message: `Backend '${backend.id}' has no backend surface handlers`,
                backendId: backend.id,
                providerId: runtimeOwnerId,
                pluginId: backend.pluginId,
            });
        }
        return {
            surfaces: createEmptyBackendExecutionSurfaces(),
            diagnostics: Object.freeze(diagnostics),
        };
    }

    const surfaces = resolveBackendExecutionSurfacesFromHandlers(handlerBySurfaceOperation, backend, {
        resolveExternalSessionRuntimeContext: params.resolveExternalSessionRuntimeContext,
        grantExternalSessionTranscriptPath: params.grantExternalSessionTranscriptPath,
        runExternalSessionFollowWithLinkedSession: params.runExternalSessionFollowWithLinkedSession,
    });
    return {
        surfaces,
        diagnostics: Object.freeze(diagnostics),
    };
}
