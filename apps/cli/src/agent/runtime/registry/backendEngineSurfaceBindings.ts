import {
    BackendSurfaceOperationCatalogV1,
    type BackendSurfaceAvailabilityV1,
    type BackendSurfaceDeclarationV1,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';
import type {
    AttachResultV1,
    AcpSessionOperationsV1,
    BackendSurfaceResultV1,
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
    ForkRequestV1,
    SessionScopedServicesV1,
    TerminalRuntimeHostOrchestrationV1,
    TerminalRuntimeLaunchRequestV1,
} from '@happier-dev/agents';
import {
    parseCheckpointAvailabilityRequestV1,
    parseCreateCheckpointRequestV1,
    parseResolveCheckpointRestoreTargetRequestV1,
    parseRestoreCheckpointRequestV1,
} from '@happier-dev/agents';
import type { AgentRuntimeV1 } from '@happier-dev/plugin-sdk';
import type { ProviderAttachEligibility, ProviderAttachScope } from '@/agent/catalog/types';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';

import { buildBackendSurfaceDispatchKey } from '../../../plugins/manifest/adapters';
import type { ResolvedAgentRuntimeContribution } from '../../../plugins/projection/registry/types';

import type {
    BackendExecutionSurfaces,
    EngineResolutionDiagnostic,
} from './engineRegistryTypes';
import { evaluateBackendSurfaceAvailability } from './backendSurfaceAvailability';
import { mapExternalSessionLaunchHintsToSpawnOptions } from './externalSessionLaunchHints';

type HandoffAvailability = NonNullable<NonNullable<BackendExecutionSurfaces['handoff']>['evaluateAvailability']>;
type ForkAvailability = NonNullable<NonNullable<BackendExecutionSurfaces['fork']>['evaluateAvailability']>;
type TerminalRuntimeAvailability = NonNullable<NonNullable<BackendExecutionSurfaces['terminalRuntime']>['evaluateAvailability']>;
type TerminalRuntimeLaunch = NonNullable<NonNullable<BackendExecutionSurfaces['terminalRuntime']>['launch']>;
type ExternalSessionAvailability = NonNullable<NonNullable<BackendExecutionSurfaces['externalSession']>['evaluateAvailability']>;
type TerminalRuntimeLaunchServicesResolver = (
    request: TerminalRuntimeLaunchRequestV1,
) => SessionScopedServicesV1 | null | Promise<SessionScopedServicesV1 | null>;
type TerminalRuntimeLaunchSignalResolver = (
    request: TerminalRuntimeLaunchRequestV1,
) => AbortSignal | undefined;
type TerminalRuntimeHostOrchestrationResolver = (
    request: TerminalRuntimeLaunchRequestV1,
) => TerminalRuntimeHostOrchestrationV1 | null | Promise<TerminalRuntimeHostOrchestrationV1 | null>;
type ExternalSessionRuntimeContextResolver = (
    request: Readonly<{
        operation: ExternalSessionAvailabilityOperationV1;
        source?: ExternalSessionsSource;
        providerSessionId?: string;
        linkedSessionId?: string;
        directory?: string;
    }>,
) => ExternalSessionRuntimeContextV1 | null | Promise<ExternalSessionRuntimeContextV1 | null>;
type ExternalSessionTranscriptPathGrantIssuer = (
    request: Readonly<{
        path: string;
        source: ExternalSessionsSource;
        providerSessionId: string;
        sourceId?: string;
        sessionId?: string | null;
    }>,
) => void | Promise<void>;
type ExternalSessionFollowScopeRunner = <T>(
    sessionId: string | null,
    operation: () => Promise<T>,
) => Promise<T>;
type AcpSessionOperationsResolver = (
    request: ForkRequestV1,
) => AcpSessionOperationsV1 | null | Promise<AcpSessionOperationsV1 | null>;

function collectDeclaredBackendSurfaceOperations(
    backend: ResolvedAgentRuntimeContribution,
): ReadonlySet<string> {
    const declaredOperations = new Set<string>();
    for (const surfaceHandler of backend.surfaceHandlers ?? []) {
        if (surfaceHandler.support === 'unsupported') {
            continue;
        }
        declaredOperations.add(buildBackendSurfaceDispatchKey({
            kind: surfaceHandler.kind,
            operation: surfaceHandler.operation,
        }));
    }
    return declaredOperations;
}

function hasDeclaredBackendSurfaceOperation(
    declaredOperations: ReadonlySet<string>,
    kind: BackendSurfaceDeclarationV1['kind'],
    operation: BackendSurfaceDeclarationV1['operation'],
): boolean {
    return declaredOperations.has(buildBackendSurfaceDispatchKey({ kind, operation }));
}

function addImplementedBackendSurfaceOperation(
    operations: Set<string>,
    kind: BackendSurfaceDeclarationV1['kind'],
    operation: BackendSurfaceDeclarationV1['operation'],
    value: unknown,
): void {
    if (typeof value !== 'function') {
        return;
    }
    operations.add(buildBackendSurfaceDispatchKey({ kind, operation }));
}

export function collectEngineImplementedBackendSurfaceOperations(engine: AgentRuntimeV1): ReadonlySet<string> {
    const operations = new Set<string>();
    const catalog = BackendSurfaceOperationCatalogV1;
    const terminal = engine.terminalRuntimeSurface;
    addImplementedBackendSurfaceOperation(operations, 'terminalRuntime', catalog.terminalRuntime.evaluateAvailability, terminal?.evaluateAvailability);
    addImplementedBackendSurfaceOperation(operations, 'terminalRuntime', catalog.terminalRuntime.launch, terminal?.launch);
    addImplementedBackendSurfaceOperation(operations, 'terminalRuntime', catalog.terminalRuntime.discoverIdentity, terminal?.discoverIdentity);
    addImplementedBackendSurfaceOperation(operations, 'terminalRuntime', catalog.terminalRuntime.resolveTranscriptBinding, terminal?.resolveTranscriptBinding);

    const externalSession = engine.externalSessionSurface;
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.evaluateAvailability, externalSession?.evaluateAvailability);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.resolveSource, externalSession?.resolveSource);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.listCandidates, externalSession?.listCandidates);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.getActivity, externalSession?.getActivity);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.pageTranscript, externalSession?.pageTranscript);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.readAfterTranscript, externalSession?.readAfterTranscript);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.resolveFollowTranscriptPath, externalSession?.resolveFollowTranscriptPath);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.acquireFollowLease, externalSession?.acquireFollowLease);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.resolveLinkIdentity, externalSession?.resolveLinkIdentity);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.resolveLinkedIdentity, externalSession?.resolveLinkedIdentity);
    addImplementedBackendSurfaceOperation(operations, 'externalSession', catalog.externalSession.resolveTakeoverLaunch, externalSession?.resolveTakeoverLaunch);

    const attach = engine.attachSurface;
    addImplementedBackendSurfaceOperation(operations, 'attach', catalog.attach.evaluateAvailability, attach?.evaluateAvailability);
    addImplementedBackendSurfaceOperation(operations, 'attach', catalog.attach.attach, attach?.attach);

    const handoff = engine.handoffSurface;
    addImplementedBackendSurfaceOperation(operations, 'handoff', catalog.handoff.evaluateAvailability, handoff?.evaluateAvailability);
    addImplementedBackendSurfaceOperation(operations, 'handoff', catalog.handoff.exportBundle, handoff?.exportBundle);
    addImplementedBackendSurfaceOperation(operations, 'handoff', catalog.handoff.importBundle, handoff?.importBundle);

    const fork = engine.forkSurface;
    addImplementedBackendSurfaceOperation(operations, 'fork', catalog.fork.evaluateAvailability, fork?.evaluateAvailability);
    addImplementedBackendSurfaceOperation(operations, 'fork', catalog.fork.fork, fork?.fork);
    addImplementedBackendSurfaceOperation(operations, 'fork', catalog.fork.resolveReplayChildLaunch, fork?.resolveReplayChildLaunch);

    const checkpoint = engine.checkpointSurface;
    addImplementedBackendSurfaceOperation(operations, 'checkpoint', catalog.checkpoint.evaluateAvailability, checkpoint?.evaluateAvailability);
    addImplementedBackendSurfaceOperation(operations, 'checkpoint', catalog.checkpoint.list, checkpoint?.list);
    addImplementedBackendSurfaceOperation(operations, 'checkpoint', catalog.checkpoint.resolveRestoreTarget, checkpoint?.resolveRestoreTarget);
    addImplementedBackendSurfaceOperation(operations, 'checkpoint', catalog.checkpoint.checkpoint, checkpoint?.checkpoint);
    addImplementedBackendSurfaceOperation(operations, 'checkpoint', catalog.checkpoint.restore, checkpoint?.restore);
    return operations;
}

function appendUndeclaredEngineSurfaceDiagnostics(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    declaredOperations: ReadonlySet<string>;
    implementedOperations: ReadonlySet<string>;
    diagnostics: EngineResolutionDiagnostic[];
}>): void {
    for (const operationKey of params.implementedOperations) {
        if (params.declaredOperations.has(operationKey)) {
            continue;
        }
        const runtimeOwnerId = params.backend.agentId;
        params.diagnostics.push({
            code: 'engine_plugin_backend_surface_static_mismatch',
            message: `Backend '${params.backend.id}' returned executable surface operation '${operationKey}' that is not declared in manifest surfaceHandlers`,
            backendId: params.backend.id,
            providerId: runtimeOwnerId,
            pluginId: params.backend.pluginId,
        });
    }
}

function hasObjectKeys(value: Record<string, unknown>): boolean {
    return Object.keys(value).length > 0;
}

type ExternalSessionSurface = NonNullable<BackendExecutionSurfaces['externalSession']>;
type ExternalValidateSource = NonNullable<ExternalSessionSurface['validateSource']>;
type ExternalListCandidates = NonNullable<ExternalSessionSurface['listCandidates']>;
type ExternalGetActivity = NonNullable<ExternalSessionSurface['getActivity']>;
type ExternalPageTranscript = NonNullable<ExternalSessionSurface['pageTranscript']>;
type ExternalReadAfterTranscript = NonNullable<ExternalSessionSurface['readAfterTranscript']>;
type ExternalResolveFollowTranscriptPath = NonNullable<ExternalSessionSurface['resolveFollowTranscriptPath']>;
type ExternalResolveTakeoverSpawnOptions = NonNullable<ExternalSessionSurface['resolveTakeoverSpawnOptions']>;
type ExternalAcquireFollowLease = NonNullable<ExternalSessionSurface['acquireFollowLease']>;
type ExternalCanonicalizeLinkedSession = NonNullable<ExternalSessionSurface['canonicalizeLinkedSession']>;
type ExternalResolveLinkIdentity = NonNullable<ExternalSessionSurface['resolveLinkIdentity']>;
type AttachExecutionSurface = NonNullable<BackendExecutionSurfaces['attach']>;
type AttachEvaluateAvailability = AttachExecutionSurface['evaluateAvailability'];
type AttachRun = AttachExecutionSurface['attach'];

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
    result: BackendSurfaceResultV1<TValue, string> | Promise<BackendSurfaceResultV1<TValue, string>>,
): Promise<TValue> {
    const settled = await result;
    if (!settled.ok) {
        failBackendSurfaceResult(operation, settled);
    }
    return settled.value;
}

async function unwrapTakeoverLaunchResult(
    operation: string,
    result: BackendSurfaceResultV1<ExternalSessionTakeoverLaunchResultV1, string>
        | Promise<BackendSurfaceResultV1<ExternalSessionTakeoverLaunchResultV1, string>>,
): Promise<ExternalSessionTakeoverLaunchResultV1 | null> {
    const settled = await result;
    if (!settled.ok) {
        if (settled.code === 'takeover_not_available') {
            return null;
        }
        failBackendSurfaceResult(operation, settled);
    }
    return settled.value;
}

function resolveLegacyAttachScope(params: Parameters<AttachEvaluateAvailability>[0]): ProviderAttachScope {
    if (params.hasLocalAttachmentInfo) {
        return 'local';
    }
    if (params.currentMachineId && params.sessionMachineId && params.currentMachineId === params.sessionMachineId) {
        return 'local';
    }
    return 'remote';
}

function mapAvailabilityToLegacyAttachEligibility(
    params: Parameters<AttachEvaluateAvailability>[0],
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

function normalizeTerminalRuntimeLaunchRequest(request: unknown): TerminalRuntimeLaunchRequestV1 {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('Terminal runtime launch request must be an object');
    }
    return request as TerminalRuntimeLaunchRequestV1;
}

function readTerminalRuntimeLaunchSessionId(request: TerminalRuntimeLaunchRequestV1): string | null {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
    return sessionId.length > 0 ? sessionId : null;
}

function hasTerminalRuntimeHostProjection(host: TerminalRuntimeHostOrchestrationV1): boolean {
    const projection = host.projection;
    return typeof projection?.openDirectTranscriptMirror === 'function'
        && typeof projection.publishControlState === 'function'
        && typeof projection.publishProviderSessionId === 'function'
        && typeof projection.publishSubagentStarted === 'function'
        && typeof projection.publishSubagentCompleted === 'function';
}

function readExternalSessionRuntimeSessionId(runtime: ExternalSessionRuntimeContextV1 | undefined): string | null {
    const sessionId = typeof runtime?.session?.sessionId === 'string' ? runtime.session.sessionId.trim() : '';
    return sessionId.length > 0 ? sessionId : null;
}

function sanitizeExternalSessionRuntimeContext(
    runtime: ExternalSessionRuntimeContextV1 | null | undefined,
): ExternalSessionRuntimeContextV1 | undefined {
    if (!runtime) {
        return undefined;
    }
    const sessionId = typeof runtime.session?.sessionId === 'string' && runtime.session.sessionId.trim().length > 0
        ? runtime.session.sessionId
        : null;
    const directory = typeof runtime.session?.directory === 'string' && runtime.session.directory.trim().length > 0
        ? runtime.session.directory
        : null;
    const activeServerDir = typeof runtime.directories?.activeServerDir === 'string' && runtime.directories.activeServerDir.trim().length > 0
        ? runtime.directories.activeServerDir
        : null;
    const logsDir = typeof runtime.directories?.logsDir === 'string' && runtime.directories.logsDir.trim().length > 0
        ? runtime.directories.logsDir
        : null;
    const fileFollow = runtime.transcripts?.fileFollow;
    const externalTranscripts = runtime.external?.transcripts;
    const externalCandidates = runtime.external?.candidates;
    return Object.freeze({
        signal: runtime.signal,
        ...(sessionId || directory
            ? {
                session: Object.freeze({
                    ...(sessionId ? { sessionId } : {}),
                    ...(directory ? { directory } : {}),
                }),
            }
            : {}),
        ...(activeServerDir || logsDir
            ? {
                directories: Object.freeze({
                    ...(activeServerDir ? { activeServerDir } : {}),
                    ...(logsDir ? { logsDir } : {}),
                }),
            }
            : {}),
        ...(fileFollow
            ? {
                transcripts: Object.freeze({
                    fileFollow,
                }),
            }
            : {}),
        ...(externalTranscripts || externalCandidates
            ? {
                external: Object.freeze({
                    ...(externalTranscripts ? { transcripts: externalTranscripts } : {}),
                    ...(externalCandidates ? { candidates: externalCandidates } : {}),
                }),
            }
            : {}),
        diagnostics: Object.freeze({
            issue: runtime.diagnostics.issue,
        }),
    });
}

async function resolveTerminalRuntimeLaunchRequestContext(params: Readonly<{
    request: TerminalRuntimeLaunchRequestV1;
    resolveServices?: TerminalRuntimeLaunchServicesResolver;
    resolveSignal?: TerminalRuntimeLaunchSignalResolver;
    resolveHostOrchestration?: TerminalRuntimeHostOrchestrationResolver;
}>): Promise<TerminalRuntimeLaunchRequestV1> {
    const sessionId = readTerminalRuntimeLaunchSessionId(params.request);
    const resolvedServices = params.resolveServices && sessionId
        ? await params.resolveServices(params.request)
        : params.request.services;
    if (params.resolveServices && sessionId && !resolvedServices) {
        throw new Error(`Terminal runtime launch for session '${sessionId}' requires session-scoped services`);
    }
    const host = params.resolveHostOrchestration && sessionId
        ? await params.resolveHostOrchestration(params.request)
        : params.request.host;
    if (params.resolveHostOrchestration && sessionId && !host) {
        throw new Error(`Terminal runtime launch for session '${sessionId}' requires terminal host orchestration`);
    }
    if (host && !hasTerminalRuntimeHostProjection(host)) {
        throw new Error(`Terminal runtime launch for session '${sessionId ?? 'unknown'}' requires terminal host projection`);
    }
    const signal = params.request.signal ?? params.resolveSignal?.(params.request);
    return {
        ...params.request,
        ...(resolvedServices ? { services: resolvedServices } : {}),
        ...(host ? { host } : {}),
        ...(signal ? { signal } : {}),
    };
}

async function resolveExternalSessionRuntimeContext(params: Readonly<{
    request: Parameters<ExternalSessionRuntimeContextResolver>[0];
    resolveRuntimeContext?: ExternalSessionRuntimeContextResolver;
}>): Promise<ExternalSessionRuntimeContextV1 | undefined> {
    const runtime = await params.resolveRuntimeContext?.(params.request);
    return sanitizeExternalSessionRuntimeContext(runtime);
}

export function resolveBackendExecutionSurfacesFromEngine(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    engine: AgentRuntimeV1;
    diagnostics: EngineResolutionDiagnostic[];
    resolveTerminalRuntimeLaunchServices?: TerminalRuntimeLaunchServicesResolver;
    resolveTerminalRuntimeLaunchSignal?: TerminalRuntimeLaunchSignalResolver;
    resolveTerminalRuntimeHostOrchestration?: TerminalRuntimeHostOrchestrationResolver;
    resolveExternalSessionRuntimeContext?: ExternalSessionRuntimeContextResolver;
    grantExternalSessionTranscriptPath?: ExternalSessionTranscriptPathGrantIssuer;
    runExternalSessionFollowWithLinkedSession?: ExternalSessionFollowScopeRunner;
    resolveAcpSessionOperations?: AcpSessionOperationsResolver;
}>): BackendExecutionSurfaces {
    const declaredOperations = collectDeclaredBackendSurfaceOperations(params.backend);
    const implementedOperations = collectEngineImplementedBackendSurfaceOperations(params.engine);
    appendUndeclaredEngineSurfaceDiagnostics({
        backend: params.backend,
        declaredOperations,
        implementedOperations,
        diagnostics: params.diagnostics,
    });

    const catalog = BackendSurfaceOperationCatalogV1;
    const terminal = params.engine.terminalRuntimeSurface;
    const terminalRuntime = terminal
        ? {
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'terminalRuntime', catalog.terminalRuntime.evaluateAvailability)
            && typeof terminal.evaluateAvailability === 'function'
                ? {
                    evaluateAvailability: ((request) =>
                        evaluateBackendSurfaceAvailability(terminal.evaluateAvailability!, request)
                    ) satisfies TerminalRuntimeAvailability,
                }
                : {}),
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'terminalRuntime', catalog.terminalRuntime.launch)
            && typeof terminal.launch === 'function'
                ? {
                    launch: (async (request) => {
                        const launchRequest = await resolveTerminalRuntimeLaunchRequestContext({
                            request: normalizeTerminalRuntimeLaunchRequest(request),
                            resolveServices: params.resolveTerminalRuntimeLaunchServices,
                            resolveSignal: params.resolveTerminalRuntimeLaunchSignal,
                            resolveHostOrchestration: params.resolveTerminalRuntimeHostOrchestration,
                        });
                        return await terminal.launch!(launchRequest);
                    }) satisfies TerminalRuntimeLaunch,
                }
                : {}),
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'terminalRuntime', catalog.terminalRuntime.discoverIdentity)
            && typeof terminal.discoverIdentity === 'function'
                ? { discoverIdentity: terminal.discoverIdentity as NonNullable<BackendExecutionSurfaces['terminalRuntime']>['discoverIdentity'] }
                : {}),
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'terminalRuntime', catalog.terminalRuntime.resolveTranscriptBinding)
            && typeof terminal.resolveTranscriptBinding === 'function'
                ? { resolveTranscriptBinding: terminal.resolveTranscriptBinding as NonNullable<BackendExecutionSurfaces['terminalRuntime']>['resolveTranscriptBinding'] }
                : {}),
        }
        : {};

    const external = params.engine.externalSessionSurface;
    const externalEvaluateAvailability = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.evaluateAvailability)
        && typeof external?.evaluateAvailability === 'function'
        ? external.evaluateAvailability
        : null;
    const externalValidateSource = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.resolveSource)
        && typeof external?.resolveSource === 'function'
        ? external.resolveSource
        : null;
    const externalListCandidates = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.listCandidates)
        && typeof external?.listCandidates === 'function'
        ? external.listCandidates
        : null;
    const externalGetActivity = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.getActivity)
        && typeof external?.getActivity === 'function'
        ? external.getActivity
        : null;
    const externalPageTranscript = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.pageTranscript)
        && typeof external?.pageTranscript === 'function'
        ? external.pageTranscript
        : null;
    const externalReadAfterTranscript = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.readAfterTranscript)
        && typeof external?.readAfterTranscript === 'function'
        ? external.readAfterTranscript
        : null;
    const externalResolveFollowTranscriptPath = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.resolveFollowTranscriptPath)
        && typeof external?.resolveFollowTranscriptPath === 'function'
        ? external.resolveFollowTranscriptPath
        : null;
    const externalResolveTakeoverSpawnOptions = hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.resolveTakeoverLaunch)
        && typeof external?.resolveTakeoverLaunch === 'function'
        ? external.resolveTakeoverLaunch
        : null;
    const externalSession = {
            ...(externalEvaluateAvailability
                ? {
                    evaluateAvailability: ((request) =>
                        evaluateBackendSurfaceAvailability(externalEvaluateAvailability, request)
                    ) satisfies ExternalSessionAvailability,
                }
                : {}),
            ...(externalValidateSource
                ? {
                    validateSource: async (request: Parameters<ExternalValidateSource>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'resolveSource',
                                source: request.source,
                            },
                        });
                        const result = await externalValidateSource({
                            source: request.source,
                            ...(request.env ? { env: request.env } : {}),
                            ...(runtime ? { runtime } : {}),
                        });
                        if (!result.ok) {
                            return {
                                ok: false as const,
                                error: result.message ?? result.code ?? 'invalid_source',
                            };
                        }
                        const value: ExternalSessionResolveSourceResultV1 = result.value;
                        return {
                            ok: true as const,
                            source: value.source,
                        };
                    },
                }
                : {}),
            ...(externalListCandidates
                ? {
                    listCandidates: async (request: Parameters<ExternalListCandidates>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'listCandidates',
                                source: request.source,
                            },
                        });
                        const value = await unwrapBackendSurfaceResult<ExternalSessionCandidatePageV1>(
                            'externalSession.listCandidates',
                            externalListCandidates({
                                ...request,
                                ...(runtime ? { runtime } : {}),
                            }),
                        );
                        return {
                            candidates: [...value.candidates],
                            nextCursor: value.nextCursor,
                            ...(value.searchIncomplete ? { searchIncomplete: true as const } : {}),
                        };
                    },
                }
                : {}),
            ...(externalGetActivity
                ? {
                    getActivity: async (request: Parameters<ExternalGetActivity>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'getActivity',
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                            },
                        });
                        return await unwrapBackendSurfaceResult<ExternalSessionActivityResultV1>(
                            'externalSession.getActivity',
                            externalGetActivity({
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                                ...(runtime ? { runtime } : {}),
                            }),
                        );
                    },
                }
                : {}),
            ...(externalPageTranscript
                ? {
                    pageTranscript: async (request: Parameters<ExternalPageTranscript>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'pageTranscript',
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                            },
                        });
                        const value = await unwrapBackendSurfaceResult<ExternalSessionTranscriptPageV1>(
                            'externalSession.pageTranscript',
                            externalPageTranscript({
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                                direction: request.direction,
                                cursor: request.cursor,
                                maxBytes: request.maxBytes,
                                maxItems: request.maxItems,
                                ...(runtime ? { runtime } : {}),
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
            ...(externalReadAfterTranscript
                ? {
                    readAfterTranscript: async (request: Parameters<ExternalReadAfterTranscript>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'readAfterTranscript',
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                            },
                        });
                        const value = await unwrapBackendSurfaceResult<ExternalSessionTranscriptPageV1>(
                            'externalSession.readAfterTranscript',
                            externalReadAfterTranscript({
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                                cursor: request.cursor,
                                maxBytes: request.maxBytes,
                                maxItems: request.maxItems,
                                ...(runtime ? { runtime } : {}),
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
            ...(externalResolveFollowTranscriptPath
                ? {
                    resolveFollowTranscriptPath: async (request: Parameters<ExternalResolveFollowTranscriptPath>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'resolveFollowTranscriptPath',
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                                linkedSessionId: request.linkedSessionId,
                            },
                        });
                        const value = await unwrapBackendSurfaceResult<ExternalSessionFollowTranscriptPathResolutionV1>(
                            'externalSession.resolveFollowTranscriptPath',
                            externalResolveFollowTranscriptPath({
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
            ...(externalResolveTakeoverSpawnOptions
                ? {
                    resolveTakeoverSpawnOptions: async (request: Parameters<ExternalResolveTakeoverSpawnOptions>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'resolveTakeoverLaunch',
                                source: request.linked.source,
                                providerSessionId: request.linked.remoteSessionId,
                                linkedSessionId: request.sessionId,
                                ...(typeof request.linked.sessionPath === 'string'
                                    ? { directory: request.linked.sessionPath }
                                    : {}),
                            },
                        });
                        const value = await unwrapTakeoverLaunchResult(
                            'externalSession.resolveTakeoverLaunch',
                            externalResolveTakeoverSpawnOptions({
                                linkedSessionId: request.sessionId,
                                providerSessionId: request.linked.remoteSessionId,
                                source: request.linked.source,
                                metadata: request.linked.metadata,
                                ...(runtime ? { runtime } : {}),
                            }),
                        );
                        if (!value) {
                            return null;
                        }
                        return mapExternalSessionLaunchHintsToSpawnOptions({
                            backend: params.backend,
                            hints: value.launch,
                            linked: request.linked,
                            sessionId: request.sessionId,
                        });
                    },
                }
                : {}),
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.acquireFollowLease)
            && typeof external?.acquireFollowLease === 'function'
                ? {
                    acquireFollowLease: async (request: Parameters<ExternalAcquireFollowLease>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'acquireFollowLease',
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                                linkedSessionId: request.linkedSessionId,
                            },
                        });
                        const sessionId = readExternalSessionRuntimeSessionId(runtime) ?? request.linkedSessionId ?? null;
                        if (params.grantExternalSessionTranscriptPath) {
                            if (!externalResolveFollowTranscriptPath) {
                                throw new Error('Backend external-session file-follow acquisition requires externalSession.resolveFollowTranscriptPath');
                            }
                            const pathResolution = await unwrapBackendSurfaceResult<ExternalSessionFollowTranscriptPathResolutionV1>(
                                'externalSession.resolveFollowTranscriptPath',
                                externalResolveFollowTranscriptPath({
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
                            external.acquireFollowLease!({
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                                reason: request.reason,
                                ...(request.linkedSessionId ? { linkedSessionId: request.linkedSessionId } : {}),
                                ...(runtime ? { runtime } : {}),
                            }),
                        );
                        return params.runExternalSessionFollowWithLinkedSession
                            ? await params.runExternalSessionFollowWithLinkedSession(sessionId, acquire)
                            : await acquire();
                    },
                }
                : {}),
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.resolveLinkedIdentity)
            && typeof external?.resolveLinkedIdentity === 'function'
                ? {
                    canonicalizeLinkedSession: async (request: Parameters<ExternalCanonicalizeLinkedSession>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'resolveLinkedIdentity',
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                            },
                        });
                        const value = await unwrapBackendSurfaceResult<ExternalSessionResolvedIdentityV1>(
                            'externalSession.resolveLinkedIdentity',
                            external.resolveLinkedIdentity!({
                                metadata: request.metadata,
                                providerSessionId: request.remoteSessionId,
                                source: request.source,
                                ...(runtime ? { runtime } : {}),
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
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'externalSession', catalog.externalSession.resolveLinkIdentity)
            && typeof external?.resolveLinkIdentity === 'function'
                ? {
                    resolveLinkIdentity: async (request: Parameters<ExternalResolveLinkIdentity>[0]) => {
                        const runtime = sanitizeExternalSessionRuntimeContext(request.runtime)
                            ?? await resolveExternalSessionRuntimeContext({
                            resolveRuntimeContext: params.resolveExternalSessionRuntimeContext,
                            request: {
                                operation: 'resolveLinkIdentity',
                                source: request.source,
                                providerSessionId: request.remoteSessionId,
                            },
                        });
                        const value = await unwrapBackendSurfaceResult<ExternalSessionResolvedIdentityV1>(
                            'externalSession.resolveLinkIdentity',
                            external.resolveLinkIdentity!({
                                providerSessionId: request.remoteSessionId,
                                source: request.source,
                                runtimeDescriptor: request.runtimeDescriptor,
                                metadata: request.metadata,
                                ...(runtime ? { runtime } : {}),
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
    const materializedExternalSession = hasObjectKeys(externalSession) ? externalSession : null;

    const attach = params.engine.attachSurface;
    const attachAvailability = hasDeclaredBackendSurfaceOperation(declaredOperations, 'attach', catalog.attach.evaluateAvailability)
        && typeof attach?.evaluateAvailability === 'function'
        ? (async (request: Parameters<AttachEvaluateAvailability>[0]) => {
            const availability = await evaluateBackendSurfaceAvailability(
                attach.evaluateAvailability!,
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
            return mapAvailabilityToLegacyAttachEligibility(request, availability);
        }) satisfies AttachEvaluateAvailability
        : null;
    const attachRun = hasDeclaredBackendSurfaceOperation(declaredOperations, 'attach', catalog.attach.attach)
        && typeof attach?.attach === 'function'
        ? (async (request: Parameters<AttachRun>[0]) => {
            const value = await unwrapBackendSurfaceResult<AttachResultV1>(
                'attach.attach',
                attach.attach({
                    sessionId: request.sessionId,
                    metadata: request.metadata,
                }),
            );
            return typeof value.exitCode === 'number' ? value.exitCode : false;
        }) satisfies AttachRun
        : null;
    const attachSurface = attachAvailability && attachRun
        ? { evaluateAvailability: attachAvailability, attach: attachRun }
        : null;

    const handoff = params.engine.handoffSurface;
    const handoffAvailability = hasDeclaredBackendSurfaceOperation(declaredOperations, 'handoff', catalog.handoff.evaluateAvailability)
        && typeof handoff?.evaluateAvailability === 'function'
        ? ((request: Parameters<HandoffAvailability>[0]) =>
            evaluateBackendSurfaceAvailability(handoff.evaluateAvailability!, request)
        ) satisfies HandoffAvailability
        : null;
    const exportBundle = hasDeclaredBackendSurfaceOperation(declaredOperations, 'handoff', catalog.handoff.exportBundle)
        && typeof handoff?.exportBundle === 'function'
        ? handoff.exportBundle
        : null;
    const importBundle = hasDeclaredBackendSurfaceOperation(declaredOperations, 'handoff', catalog.handoff.importBundle)
        && typeof handoff?.importBundle === 'function'
        ? handoff.importBundle
        : null;
    const handoffSurface = exportBundle && importBundle
        ? {
            ...(handoffAvailability ? { evaluateAvailability: handoffAvailability } : {}),
            exportBundle,
            importBundle,
        }
        : null;

    const fork = params.engine.forkSurface;
    const forkAvailability = hasDeclaredBackendSurfaceOperation(declaredOperations, 'fork', catalog.fork.evaluateAvailability)
        && typeof fork?.evaluateAvailability === 'function'
        ? ((request: Parameters<ForkAvailability>[0]) =>
            evaluateBackendSurfaceAvailability(fork.evaluateAvailability!, request)
        ) satisfies ForkAvailability
        : null;
    const forkRun = hasDeclaredBackendSurfaceOperation(declaredOperations, 'fork', catalog.fork.fork)
        && typeof fork?.fork === 'function'
        ? (async (request: Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['fork']>['fork']>>[0]) => {
            const acp = request.acp ?? await params.resolveAcpSessionOperations?.(request);
            return await fork.fork!({
                ...request,
                ...(acp ? { acp } : {}),
            });
        }) satisfies NonNullable<NonNullable<BackendExecutionSurfaces['fork']>['fork']>
        : null;
    const replayChildLaunch = hasDeclaredBackendSurfaceOperation(declaredOperations, 'fork', catalog.fork.resolveReplayChildLaunch)
        && typeof fork?.resolveReplayChildLaunch === 'function'
        ? fork.resolveReplayChildLaunch as NonNullable<BackendExecutionSurfaces['fork']>['resolveReplayChildLaunch']
        : null;
    const forkSurface = forkAvailability || forkRun || replayChildLaunch
        ? {
            ...(forkAvailability ? { evaluateAvailability: forkAvailability } : {}),
            ...(forkRun ? { fork: forkRun } : {}),
            ...(replayChildLaunch ? { resolveReplayChildLaunch: replayChildLaunch } : {}),
        }
        : null;

    const checkpoint = params.engine.checkpointSurface;
    const checkpointEvaluateAvailability = hasDeclaredBackendSurfaceOperation(declaredOperations, 'checkpoint', catalog.checkpoint.evaluateAvailability)
        && typeof checkpoint?.evaluateAvailability === 'function'
        ? checkpoint.evaluateAvailability
        : null;
    const checkpointResolveRestoreTarget = hasDeclaredBackendSurfaceOperation(declaredOperations, 'checkpoint', catalog.checkpoint.resolveRestoreTarget)
        && typeof checkpoint?.resolveRestoreTarget === 'function'
        ? checkpoint.resolveRestoreTarget
        : null;
    const checkpointRestore = hasDeclaredBackendSurfaceOperation(declaredOperations, 'checkpoint', catalog.checkpoint.restore)
        && typeof checkpoint?.restore === 'function'
        ? checkpoint.restore
        : null;
    const checkpointSurface = checkpoint
        ? {
            ...(checkpointEvaluateAvailability
                ? {
                    evaluateAvailability: ((request) => (
                        evaluateBackendSurfaceAvailability(
                            checkpointEvaluateAvailability,
                            parseCheckpointAvailabilityRequestV1(request),
                        )
                    )) as NonNullable<BackendExecutionSurfaces['checkpoint']>['evaluateAvailability'],
                }
                : {}),
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'checkpoint', catalog.checkpoint.list)
            && typeof checkpoint.list === 'function'
                ? { list: checkpoint.list as NonNullable<BackendExecutionSurfaces['checkpoint']>['list'] }
                : {}),
            ...(checkpointResolveRestoreTarget
                ? {
                    resolveRestoreTarget: ((request) => (
                        checkpointResolveRestoreTarget(parseResolveCheckpointRestoreTargetRequestV1(request))
                    )) as NonNullable<BackendExecutionSurfaces['checkpoint']>['resolveRestoreTarget'],
                }
                : {}),
            ...(hasDeclaredBackendSurfaceOperation(declaredOperations, 'checkpoint', catalog.checkpoint.checkpoint)
            && typeof checkpoint.checkpoint === 'function'
                ? {
                    checkpoint: ((request) => (
                        checkpoint.checkpoint!(parseCreateCheckpointRequestV1(request))
                    )) as NonNullable<BackendExecutionSurfaces['checkpoint']>['checkpoint'],
                }
                : {}),
            ...(checkpointRestore
                ? {
                    restore: ((request) => (
                        checkpointRestore(parseRestoreCheckpointRequestV1(request))
                    )) as NonNullable<BackendExecutionSurfaces['checkpoint']>['restore'],
                }
                : {}),
        }
        : {};

    return {
        terminalRuntime: hasObjectKeys(terminalRuntime) ? terminalRuntime : null,
        externalSession: materializedExternalSession,
        attach: attachSurface,
        handoff: handoffSurface,
        fork: forkSurface,
        checkpoint: hasObjectKeys(checkpointSurface) ? checkpointSurface : null,
    };
}

function assertNoDuplicateSurfaceOperations<TSurface extends object>(
    surfaceName: keyof BackendExecutionSurfaces,
    handlerSurface: TSurface | null,
    engineSurface: TSurface | null,
): void {
    if (!handlerSurface || !engineSurface) {
        return;
    }
    for (const operation of Object.keys(handlerSurface) as Array<keyof TSurface & string>) {
        if (
            typeof handlerSurface[operation] === 'function'
            && typeof engineSurface[operation] === 'function'
        ) {
            throw new Error(`Duplicate backend surface operation '${String(surfaceName)}.${operation}' from handler and engine surfaces`);
        }
    }
}

function mergeSurface<TSurface extends object>(
    surfaceName: keyof BackendExecutionSurfaces,
    handlerSurface: TSurface | null,
    engineSurface: TSurface | null,
): TSurface | null {
    assertNoDuplicateSurfaceOperations(surfaceName, handlerSurface, engineSurface);
    if (!handlerSurface) {
        return engineSurface;
    }
    if (!engineSurface) {
        return handlerSurface;
    }
    return {
        ...handlerSurface,
        ...engineSurface,
    } as TSurface;
}

export function mergeBackendExecutionSurfaces(
    handlerSurfaces: BackendExecutionSurfaces,
    engineSurfaces: BackendExecutionSurfaces,
): BackendExecutionSurfaces {
    return {
        terminalRuntime: mergeSurface('terminalRuntime', handlerSurfaces.terminalRuntime, engineSurfaces.terminalRuntime),
        externalSession: mergeSurface('externalSession', handlerSurfaces.externalSession, engineSurfaces.externalSession),
        attach: mergeSurface('attach', handlerSurfaces.attach, engineSurfaces.attach),
        handoff: mergeSurface('handoff', handlerSurfaces.handoff, engineSurfaces.handoff),
        fork: mergeSurface('fork', handlerSurfaces.fork, engineSurfaces.fork),
        checkpoint: mergeSurface('checkpoint', handlerSurfaces.checkpoint, engineSurfaces.checkpoint),
    };
}
