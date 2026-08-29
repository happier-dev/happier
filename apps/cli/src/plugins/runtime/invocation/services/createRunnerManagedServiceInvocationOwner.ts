import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    ManagedServiceHandle,
    ManagedServiceRequest,
    ManagedServiceResponse,
    ManagedServices } from '@happier-dev/plugin-sdk/managed-services';
import type {
    ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
    LoggerService as PluginLoggerService,
    PluginServices,
} from '@happier-dev/plugin-sdk';
import {
    createManagedServiceEndpointProjectionV1,
    type ManagedServiceEndpointProjectionInputV1,
    type ManagedServiceEndpointProjectionV1,
} from './managedServiceEndpointProjection';
import {
    type AgentProviderBindingMaterializationV1,
    type PluginAgentContributionV2,
    type PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

import type {
    AgentRuntimeDaemonServiceAuthorityExpectedInput,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import {
    claimCurrentRunnerManagedServiceEndpointRead,
    dispatchCurrentAgentRuntimeDaemonServiceRequest,
    readCurrentRunnerManagedServiceDeclaredSecret,
    revalidateCurrentRunnerManagedServiceDeclaredSecret,
    validateCurrentRunnerManagedServiceEndpointRead,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import type {
    ManagedServiceEndpointReadOpenRequestV1,
    ManagedServiceEndpointReadNextRequestV1,
    RunnerManagedServiceEndpointReadPort,
} from '@/agent/runtime/session/process/managedServiceEndpointReadProtocol';
import type {
    RunnerDaemonManagedProviderBootstrapV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import {
    isExactRunnerManagedProviderCustodyScope,
    type RunnerManagedProviderCustodyScopeV1,
    type RunnerManagedServicesExactHandleRequestPortV1,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import type { PluginStorePaths } from '@/plugins/store/paths';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import {
    readCurrentPluginHardRevocationRevision,
} from '@/plugins/store/registry/generationStore';
import {
    verifyRunnerAgentBindingAgainstGeneration,
} from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import type {
    AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
    resolveManagedProviderRuntimeExecutable,
} from '@/providers/lifecycle/resolveManagedProviderRuntimeLaunch';
import {
    addExecServiceBinding,
    createLoggerAvailablePluginInvocationServiceBinding,
    createPluginInvocationServicesFactory,
} from './factory';
import {
    createPluginInvocationLogger,
    createPluginInvocationSecretRedactor,
} from './logger';
import { createFilePluginInvocationLogSink } from './sink';
import { createProductionPluginApprovalQueueOwner } from './approvalQueueProduction';
import { resolvePluginPathWithinRoots } from './filesystem';
import { createManagedServiceCredentialFileOwner } from './managedServiceCredentialFileOwner';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import { createManagedServicesOwner } from './managedServicesOwner';
import { createDeclaredManagedServiceSecretResolver } from './declaredManagedServiceSecret';
import type { DeclaredPluginSecretReadPort } from '../../context/secrets';
import type {
    ManagedProviderEndpointAccessProjection,
    ManagedProviderEndpointPath,
} from './managedServicesAdapter';
import {
    createManagedServiceDurabilityOwner,
    observeManagedServiceProcessStartIdentity,
    type ManagedServiceProcessDurabilityOwner,
} from './managedServiceDurability';
import type { PluginInvocationServicesSeed } from './types';
import type {
    AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';

type RunnerLocalPluginServices = Pick<
    PluginServices,
    | 'availability'
    | 'logger'
    | 'sessions'
    | 'managedServices'
    | 'targetedContributions'
    | 'interactions'
    | 'composerContent'
    | 'exec'
>;

type ExactHandleEndpointReadOpenRequest = Extract<
    ManagedServiceEndpointReadOpenRequestV1,
    Readonly<{ route: Readonly<{ kind: 'exactHandle' }> }>
>;

function isExactHandleEndpointReadOpenRequest(
    request: ManagedServiceEndpointReadOpenRequestV1,
): request is ExactHandleEndpointReadOpenRequest {
    return request.route.kind === 'exactHandle';
}

type RunnerLocalPluginInvocationServiceOwners = Readonly<{
    createOperationServices(
        seed: PluginInvocationServicesSeed,
        operation: Readonly<{
            filesystemRoots: Readonly<{
                pluginData: string;
                workspace: string;
                projects: ReadonlyMap<string, string>;
            }>;
            environment?: Readonly<Record<string, string>>;
            hostAccessRequests: readonly Readonly<{
                request: PluginHostAccessRequestV2;
                required: boolean;
            }>[];
        }>,
    ): RunnerLocalPluginServices;
    registerRawForRedaction(
        seed: PluginInvocationServicesSeed,
        value: string,
    ): void;
    dispose(): Promise<void>;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function readsCurrent(read: () => boolean): boolean {
    try {
        return read() === true;
    } catch {
        return false;
    }
}

function requireBeforeEffect<T>(
    response: Awaited<
        ReturnType<typeof dispatchCurrentAgentRuntimeDaemonServiceRequest>
    >,
    read: (
        result: Extract<typeof response, { ok: true }>['result'],
    ) => T | null,
): T {
    if (response.ok) {
        const value = read(response.result);
        if (value !== null) return value;
    }
    return fail(
        'plugin_managed_server_authorization_unavailable',
        'Managed server daemon authorization is unavailable before effect',
    );
}

type RemoteRunnerManagedServiceEndpointProjectionOwner = Readonly<{
    publishEndpointProjection(
        projection: ManagedServiceEndpointProjectionInputV1,
    ): Promise<string>;
    releaseEndpointProjection(input: Readonly<{
        instanceId: string;
        projectionToken: string;
        sessionId: string;
        pluginId: string;
    }>): Promise<boolean>;
}>;

const MANAGED_SERVICE_ENDPOINT_MAX_CHUNK_BYTES = 64 * 1024;

function boundManagedServiceEndpointResponseBody(
    body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
    if (!body) return null;
    const reader = body.getReader();
    let pending: Uint8Array | null = null;
    let pendingOffset = 0;
    let settled = false;
    const releaseReader = (): void => {
        try {
            reader.releaseLock();
        } catch {
            // A pending read retains the lock until it settles.
        }
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                if (!pending) {
                    const result = await reader.read();
                    if (result.done) {
                        settled = true;
                        controller.close();
                        releaseReader();
                        return;
                    }
                    pending = result.value;
                    pendingOffset = 0;
                }
                const chunkEnd = Math.min(
                    pendingOffset
                        + MANAGED_SERVICE_ENDPOINT_MAX_CHUNK_BYTES,
                    pending.byteLength,
                );
                const chunk = pending.subarray(pendingOffset, chunkEnd);
                pendingOffset = chunkEnd;
                if (pendingOffset === pending.byteLength) {
                    pending = null;
                    pendingOffset = 0;
                }
                controller.enqueue(chunk);
            } catch (error) {
                settled = true;
                controller.error(error);
                releaseReader();
            }
        },
        async cancel(reason) {
            if (settled) return;
            settled = true;
            pending = null;
            pendingOffset = 0;
            try {
                await reader.cancel(reason);
            } finally {
                releaseReader();
            }
        },
    });
}

/**
 * How many managed-service response bodies one runner may hold open at once.
 *
 * This is an ADMISSION bound, not a lifetime: each live entry retains an abort controller, a Fetch
 * body reader and the socket underneath it, so an unbounded number of simultaneously open bodies is
 * a real runner file-descriptor and memory cost. It deliberately does not decide when an admitted
 * response ends — the public request contract gives post-header lifetime to the caller's signal and
 * the exact handle, and slots are returned by caller cancel, stream end, projection release and
 * authority retirement.
 *
 * The value is a deliberate budget rather than a measured platform limit: it is far below the
 * default POSIX descriptor ceiling while being orders of magnitude above any observed concurrent
 * managed-stream count. Raising or lowering it is a product decision, so it is named and exported
 * here instead of being an anonymous literal at the admission check.
 */
export const RUNNER_MANAGED_SERVICE_MAX_ACTIVE_ENDPOINT_READS = 128;

export function createRunnerManagedServiceEndpointProjectionBinding(
    remote: RemoteRunnerManagedServiceEndpointProjectionOwner,
    options: Readonly<{
        claimEndpointRead?: (input: Readonly<{
            requestId: string;
            projectionToken: string;
            signal?: AbortSignal;
        }>) => Promise<Readonly<{ daemonCapability: string }>>;
        validateEndpointRead?: (input: Readonly<{
            requestId: string;
            projectionToken: string;
            daemonCapability: string;
            signal?: AbortSignal;
        }>) => boolean | Promise<boolean>;
        resolveExactHandleRequestPort?: () =>
            RunnerManagedServicesExactHandleRequestPortV1 | null;
        resolveProjectedManagedServiceRequest?: (
            projection: ManagedServiceEndpointProjectionV1,
        ) => ((
            request: ManagedServiceRequest,
        ) => Promise<ManagedServiceResponse>) | null;
    }> = {},
) {
    type ProjectionEndpointAccess = Readonly<{
        projection: ManagedServiceEndpointProjectionV1;
        lifetime: AbortController;
    }>;
    const endpointAccessByProjectionToken =
        new Map<string, ProjectionEndpointAccess>();
    type ActiveRead = {
        route: ManagedServiceEndpointReadNextRequestV1['route'];
        daemonCapability: string | null;
        controller: AbortController;
        reader: ReadableStreamDefaultReader<Uint8Array> | null;
        nextPending: boolean;
    };
    const activeReads = new Map<string, ActiveRead>();

    const accessMatches = (
        projection: ManagedServiceEndpointProjectionV1,
    ): ProjectionEndpointAccess | null => {
        const access = endpointAccessByProjectionToken.get(
            projection.projectionToken,
        );
        if (!access) return null;
        return JSON.stringify(access.projection)
            === JSON.stringify(projection)
            ? access
            : null;
    };

    const unavailableEndpointRead = (): never => fail(
        'plugin_managed_server_endpoint_unavailable',
        'Managed server endpoint read owner is unavailable',
    );

    const hasCallerAuthentication = (
        headers: Readonly<Record<string, string>>,
    ): boolean => {
        try {
            const normalized = new Headers(headers);
            return normalized.has('authorization')
                || normalized.has('proxy-authorization');
        } catch {
            return true;
        }
    };

    const disposeActiveRead = (active: ActiveRead): void => {
        active.controller.abort('Managed server endpoint read cancelled');
        void active.reader?.cancel().catch(() => undefined);
    };

    const cancelActiveRead = (requestId: string): boolean => {
        const active = activeReads.get(requestId);
        if (!active) return false;
        activeReads.delete(requestId);
        disposeActiveRead(active);
        return true;
    };

    const validateActiveRead = async (
        requestId: string,
        active: ActiveRead,
        signal?: AbortSignal,
    ): Promise<boolean> => {
        if (active.route.kind === 'exactHandle') {
            try {
                return await options.resolveExactHandleRequestPort?.()
                    ?.isCurrent({
                        claim: active.route.claim,
                        serviceId: active.route.serviceId,
                    }) === true;
            } catch {
                return false;
            }
        }
        if (
            !active.daemonCapability
            || !options.validateEndpointRead
        ) return false;
        try {
            return await options.validateEndpointRead({
                requestId,
                projectionToken: active.route.projectionToken,
                daemonCapability: active.daemonCapability,
                ...(signal ? { signal } : {}),
            });
        } catch {
            return false;
        }
    };
    const continuationMatches = (
        active: ActiveRead,
        route: ManagedServiceEndpointReadNextRequestV1['route'],
    ): boolean => active.route.kind === route.kind
        && (
            route.kind === 'endpointProjection'
                ? active.route.kind === 'endpointProjection'
                    && active.route.projectionToken
                        === route.projectionToken
                : active.route.kind === 'exactHandle'
                    && isDeepStrictEqual(active.route, route)
        );
    const readBoundedResponseHeaders = (
        headers: Headers | Readonly<Record<string, string>>,
    ): Array<[string, string]> => {
        const responseHeaders: Array<[string, string]> = [];
        let serializedBytes = 0;
        const append = (value: string, name: string): void => {
            const normalizedName = name.toLowerCase();
            const entryBytes = Buffer.byteLength(name)
                + Buffer.byteLength(value);
            if (
                normalizedName === 'authorization'
                || normalizedName === 'proxy-authorization'
                || normalizedName === 'set-cookie'
                || normalizedName === 'set-cookie2'
            ) return;
            if (
                responseHeaders.length < 128
                && name.length <= 128
                && value.length <= 8_192
                && serializedBytes + entryBytes <= 65_536
            ) {
                responseHeaders.push([name, value]);
                serializedBytes += entryBytes;
            }
        };
        if (headers instanceof Headers) {
            headers.forEach(append);
        } else {
            for (const [name, value] of Object.entries(headers)) {
                append(value, name);
            }
        }
        return responseHeaders;
    };

    const endpointReadPort: RunnerManagedServiceEndpointReadPort = Object.freeze({
        async open(request, signal) {
            const unavailable = () => ({
                v: 1 as const,
                requestId: request.requestId,
                status: 'unavailable' as const,
            });
            if (
                activeReads.has(request.requestId)
                || activeReads.size
                    >= RUNNER_MANAGED_SERVICE_MAX_ACTIVE_ENDPOINT_READS
                || hasCallerAuthentication(request.headers)
            ) return unavailable();
            if (
                request.route.kind === 'endpointProjection'
                && (
                    request.route.projection.custodyOwner
                        !== 'sessionRunner'
                    || !accessMatches(request.route.projection)
                    || !options.claimEndpointRead
                )
            ) return unavailable();
            const route: ManagedServiceEndpointReadNextRequestV1['route'] =
                request.route.kind === 'exactHandle'
                    ? request.route
                    : Object.freeze({
                        kind: 'endpointProjection' as const,
                        projectionToken:
                            request.route.projection.projectionToken,
                    });
            const controller = new AbortController();
            const active: ActiveRead = {
                route,
                daemonCapability: null,
                controller,
                reader: null,
                nextPending: false,
            };
            activeReads.set(request.requestId, active);
            const onAbort = () => {
                if (!cancelActiveRead(request.requestId)) {
                    controller.abort(signal?.reason);
                }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            try {
                let response: Response | Awaited<ReturnType<
                    RunnerManagedServicesExactHandleRequestPortV1['request']
                >>;
                if (isExactHandleEndpointReadOpenRequest(request)) {
                    const exactRequest = request;
                    const exactPort =
                        options.resolveExactHandleRequestPort?.() ?? null;
                    if (
                        !exactPort
                        || !await exactPort.isCurrent({
                            claim: exactRequest.route.claim,
                            serviceId: exactRequest.route.serviceId,
                        })
                    ) {
                        cancelActiveRead(request.requestId);
                        return unavailable();
                    }
                    response = await exactPort.request({
                        claim: exactRequest.route.claim,
                        serviceId: exactRequest.route.serviceId,
                        request: {
                            pathAndQuery: exactRequest.pathAndQuery,
                            ...(exactRequest.method !== undefined
                                ? { method: exactRequest.method }
                                : {}),
                            headers: exactRequest.headers,
                            ...(exactRequest.bodyBase64 !== undefined
                                ? {
                                    body: Buffer.from(
                                        exactRequest.bodyBase64,
                                        'base64',
                                    ),
                                }
                                : {}),
                            ...(exactRequest.timeoutMs !== undefined
                                ? { timeoutMs: exactRequest.timeoutMs }
                                : {}),
                            signal: controller.signal,
                        },
                    });
                } else {
                    const projection = request.route.projection;
                    const claim = await options.claimEndpointRead!({
                        requestId: request.requestId,
                        projectionToken: projection.projectionToken,
                        signal: controller.signal,
                    });
                    if (
                        activeReads.get(request.requestId) !== active
                        || controller.signal.aborted
                        || !accessMatches(projection)
                    ) {
                        cancelActiveRead(request.requestId);
                        return unavailable();
                    }
                    active.daemonCapability = claim.daemonCapability;
                    for (const [requestId, candidate] of activeReads) {
                        if (
                            requestId !== request.requestId
                            && candidate.route.kind
                                === 'endpointProjection'
                            && candidate.daemonCapability !== null
                            && candidate.daemonCapability
                                !== claim.daemonCapability
                        ) {
                            cancelActiveRead(requestId);
                        }
                    }
                    const requestManagedService =
                        options.resolveProjectedManagedServiceRequest?.(
                            projection,
                        ) ?? null;
                    if (!requestManagedService) {
                        cancelActiveRead(request.requestId);
                        return unavailable();
                    }
                    response = await requestManagedService({
                        pathAndQuery: request.pathAndQuery,
                        headers: request.headers,
                        signal: controller.signal,
                    });
                }
                active.reader = boundManagedServiceEndpointResponseBody(
                    response.body,
                )?.getReader() ?? null;
                if (
                    activeReads.get(request.requestId) !== active
                    || controller.signal.aborted
                    || !await validateActiveRead(
                        request.requestId,
                        active,
                        controller.signal,
                    )
                ) {
                    if (activeReads.get(request.requestId) === active) {
                        activeReads.delete(request.requestId);
                    }
                    disposeActiveRead(active);
                    return unavailable();
                }
                const responseHeaders = readBoundedResponseHeaders(
                    response.headers,
                );
                if (!active.reader) activeReads.delete(request.requestId);
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'opened' as const,
                    response: {
                        status: response.status,
                        statusText: response.statusText.slice(0, 1_024),
                        headers: responseHeaders,
                        hasBody: active.reader !== null,
                    },
                };
            } catch {
                cancelActiveRead(request.requestId);
                return unavailable();
            } finally {
                signal?.removeEventListener('abort', onAbort);
            }
        },
        async next(request, signal) {
            const active = activeReads.get(request.requestId);
            const unavailable = () => ({
                v: 1 as const,
                requestId: request.requestId,
                status: 'unavailable' as const,
            });
            if (
                !active
                || !continuationMatches(active, request.route)
                || !active.reader
                || active.nextPending
            ) return unavailable();
            active.nextPending = true;
            const onAbort = () => {
                cancelActiveRead(request.requestId);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            try {
                if (
                    activeReads.get(request.requestId) !== active
                    || active.controller.signal.aborted
                    || !await validateActiveRead(
                        request.requestId,
                        active,
                        signal,
                    )
                    || activeReads.get(request.requestId) !== active
                    || active.controller.signal.aborted
                ) {
                    cancelActiveRead(request.requestId);
                    return unavailable();
                }
                const value = (await active.reader.read()).value ?? null;
                if (
                    activeReads.get(request.requestId) !== active
                    || active.controller.signal.aborted
                ) {
                    cancelActiveRead(request.requestId);
                    return unavailable();
                }
                if (!value) {
                    cancelActiveRead(request.requestId);
                    return {
                        v: 1 as const,
                        requestId: request.requestId,
                        status: 'end' as const,
                    };
                }
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'chunk' as const,
                    dataBase64: Buffer.from(value).toString('base64'),
                };
            } catch {
                cancelActiveRead(request.requestId);
                return unavailable();
            } finally {
                active.nextPending = false;
                signal?.removeEventListener('abort', onAbort);
            }
        },
        async cancel(request) {
            const active = activeReads.get(request.requestId);
            const authorized = active !== undefined
                && continuationMatches(active, request.route)
                && await validateActiveRead(
                    request.requestId,
                    active,
                );
            const cancelled = active !== undefined
                && continuationMatches(active, request.route)
                && cancelActiveRead(request.requestId);
            return {
                v: 1 as const,
                requestId: request.requestId,
                status: 'cancelled' as const,
                cancelled: authorized && cancelled,
            };
        },
    });
    return Object.freeze({
        async publishEndpointProjection(
            projectionInput: ManagedServiceEndpointProjectionInputV1,
        ): Promise<string> {
            const projection = createManagedServiceEndpointProjectionV1(
                projectionInput,
            );
            const projectionToken = await remote.publishEndpointProjection(
                projectionInput,
            );
            if (projectionToken !== projection.projectionToken) {
                return fail(
                    'plugin_managed_server_projection_identity_mismatch',
                    'Managed server endpoint publication returned a mismatched identity',
                );
            }
            endpointAccessByProjectionToken.get(projectionToken)
                ?.lifetime.abort('Managed server endpoint access replaced');
            endpointAccessByProjectionToken.set(projectionToken, Object.freeze({
                projection,
                lifetime: new AbortController(),
            }));
            return projectionToken;
        },
        async releaseEndpointProjection(input: Readonly<{
            instanceId: string;
            projectionToken: string;
            sessionId: string;
            pluginId: string;
        }>): Promise<boolean> {
            for (const [requestId, active] of activeReads) {
                if (
                    active.route.kind === 'endpointProjection'
                    && active.route.projectionToken
                        === input.projectionToken
                ) {
                    cancelActiveRead(requestId);
                }
            }
            const access = endpointAccessByProjectionToken.get(
                input.projectionToken,
            );
            access?.lifetime.abort('Managed server endpoint access released');
            endpointAccessByProjectionToken.delete(input.projectionToken);
            return await remote.releaseEndpointProjection(input);
        },
        bindExactEndpoint(bindInput: Readonly<{
            identity: Readonly<{
                pluginId: string;
                contributionId: string;
                sessionId: string;
                immutableGenerationId: string;
            }>;
            signal: AbortSignal;
        }>): AgentExternalSessionsManagedEndpointRead | null {
            if (bindInput.signal.aborted) return null;
            const matches = [...endpointAccessByProjectionToken.values()]
                .filter((access) => {
                    const projection = access.projection;
                    return projection.custodyOwner === 'sessionRunner'
                        && projection.pluginId
                            === bindInput.identity.pluginId
                        && projection.contributionId
                            === bindInput.identity.contributionId
                        && projection.sessionId
                            === bindInput.identity.sessionId
                        && projection.immutableGenerationId
                            === bindInput.identity.immutableGenerationId
                        && accessMatches(projection) === access;
                });
            if (matches.length !== 1) return null;
            const access = matches[0]!;
            const projection = access.projection;
            const requestManagedService =
                options.resolveProjectedManagedServiceRequest?.(
                    projection,
                ) ?? null;
            if (!requestManagedService) return null;
            return Object.freeze(async (request) => {
                const pathAndQuery = request.pathAndQuery;
                if (
                    bindInput.signal.aborted
                    || typeof pathAndQuery !== 'string'
                    || !pathAndQuery.startsWith('/')
                    || pathAndQuery.startsWith('//')
                    || pathAndQuery.includes('#')
                    || accessMatches(projection) !== access
                ) return unavailableEndpointRead();
                const response = await requestManagedService({
                    pathAndQuery,
                    headers: request.headers,
                    signal: bindInput.signal,
                });
                if (
                    bindInput.signal.aborted
                    || accessMatches(projection) !== access
                ) {
                    await response.body?.cancel().catch(() => undefined);
                    return unavailableEndpointRead();
                }
                return response;
            });
        },
        endpointReadPort,
        clearEndpointAuth(): void {
            for (const requestId of activeReads.keys()) {
                cancelActiveRead(requestId);
            }
            for (const access of endpointAccessByProjectionToken.values()) {
                access.lifetime.abort(
                    'Managed server endpoint access retired',
                );
            }
            endpointAccessByProjectionToken.clear();
        },
    });
}

export async function createRunnerManagedServiceInvocationOwner(input: Readonly<{
    paths: PluginStorePaths;
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    retainedAgent: AgentSessionRunnerBindingV1;
}>): Promise<Readonly<{
    owners: RunnerLocalPluginInvocationServiceOwners;
    verifiedAgentDeclaration: Readonly<{
        definition: PluginAgentContributionV2;
        provenance: 'first_party' | 'external';
    }>;
    hostAccessRequests: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[];
    bindManagedServices(input: Readonly<{
        seed: PluginInvocationServicesSeed;
        agent: Readonly<{
            exec: ExecService;
            connectedAccounts: ConnectedAccountsService;
        }>;
        managedProvider: Readonly<{
            bootstrap: RunnerDaemonManagedProviderBootstrapV1;
            exec: ExecService;
            connectedAccounts: ConnectedAccountsService;
            isCurrent(): boolean;
        }> | null;
    }>): PluginServices['managedServices'];
    resolveAuthorizedManagedProviderServices(
        scope: RunnerManagedProviderCustodyScopeV1,
    ): Readonly<{
        services: ManagedServices;
        providerPluginHardRevocationRevisionAtAdmission: number;
    }> | null;
    readCurrentProviderPluginHardRevocationRevision(
        pluginId: string,
    ): Promise<number>;
    projectManagedProviderEndpointAccess(input: Readonly<{
        scope: RunnerManagedProviderCustodyScopeV1;
        service: ManagedServiceHandle;
        endpoints: readonly ManagedProviderEndpointPath[];
        signal?: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ManagedProviderEndpointAccessProjection | null>;
    materializeManagedProviderAgentBinding(input: Readonly<{
        scope: RunnerManagedProviderCustodyScopeV1;
        service: ManagedServiceHandle;
        projection: ManagedProviderEndpointAccessProjection;
        endpointTemplateId: string;
        materialize(input: Readonly<{
            endpointUrl: string;
            credentialPlaceholder: string;
        }>): Promise<unknown>;
    }>): Promise<Readonly<{
        materialization: AgentProviderBindingMaterializationV1;
        redactionValues: readonly string[];
        transformLaunchEnvironment(
            environment: Readonly<Record<string, string>>,
        ): Readonly<Record<string, string>>;
    }> | null>;
    registerAgentChildLaunchEnvironmentTransformer(
        transform: (
            environment: Readonly<Record<string, string>>,
        ) => Readonly<Record<string, string>>,
    ): void;
    bindAgentExternalSessionsManagedEndpoint(input: Readonly<{
        identity: Readonly<{
            pluginId: string;
            agentId: string;
            generation: string;
            contributionQualifiedId: string;
            immutableGenerationId: string | null;
        }>;
        signal: AbortSignal;
    }>): AgentExternalSessionsManagedEndpointRead;
    bindManagedServicesCustodyRequestPort(
        port: RunnerManagedServicesExactHandleRequestPortV1,
    ): void;
    endpointReadPort: RunnerManagedServiceEndpointReadPort;
    clearEndpointAuth(): void;
}>> {
    const attested = await verifyRunnerAgentBindingAgainstGeneration({
        paths: input.paths,
        binding: input.retainedAgent,
    });
    const verifiedAgentDeclaration = Object.freeze({
        definition: attested.declaredAgent,
        provenance: attested.manifestAuthority === 'bundled_first_party'
            ? 'first_party' as const
            : 'external' as const,
    });
    const manifest = attested.manifest;
    const hostAccessRequests = Object.freeze([
        ...manifest.hostAccess.required.map((request) =>
            Object.freeze({ request, required: true })
        ),
        ...manifest.hostAccess.optional.map((request) =>
            Object.freeze({ request, required: false })
        ),
    ]);
    const managedServiceCredentialFileOwner =
        createManagedServiceCredentialFileOwner({
            rootDir: join(
                input.paths.secretsDir,
                'managed-services',
            ),
        });
    const projectionRootDir = join(
        input.paths.stateDir,
        'managed-servers',
    );
    const localDurability =
        createManagedServiceDurabilityOwner({
            rootDir: projectionRootDir,
            observeProcessStartIdentity:
                observeManagedServiceProcessStartIdentity,
        });
    let exactHandleRequestPort:
        RunnerManagedServicesExactHandleRequestPortV1 | null = null;
    const endpointProjectionBinding =
        createRunnerManagedServiceEndpointProjectionBinding({
            async publishEndpointProjection(
                projection,
            ) {
                const response =
                    await dispatchCurrentAgentRuntimeDaemonServiceRequest({
                        authority: input.authority,
                        createRequest: (capability) => ({
                            v: 1,
                            context: {
                                token: capability,
                                sessionId:
                                    input.authority.sessionId,
                            },
                            operation: {
                                kind:
                                    'managed_server.endpoint.publish',
                                requestId: randomUUID(),
                                projection,
                            },
                        }),
                    });
                return requireBeforeEffect(
                    response,
                    (result) =>
                        result.kind
                            === 'managed_server.endpoint'
                        && result.status === 'published'
                            ? result.projectionToken
                            : null,
                );
            },
            async releaseEndpointProjection(release) {
                const response =
                    await dispatchCurrentAgentRuntimeDaemonServiceRequest({
                        authority: input.authority,
                        createRequest: (capability) => ({
                            v: 1,
                            context: {
                                token: capability,
                                sessionId:
                                    input.authority.sessionId,
                            },
                            operation: {
                                kind:
                                    'managed_server.endpoint.release',
                                requestId: randomUUID(),
                                pluginId: release.pluginId,
                                instanceId: release.instanceId,
                                projectionToken:
                                    release.projectionToken,
                            },
                        }),
                    });
                return requireBeforeEffect(
                    response,
                    (result) =>
                        result.kind
                            === 'managed_server.endpoint'
                        && result.status === 'released'
                            ? result.released
                            : null,
                );
            },
        }, {
            claimEndpointRead: async (request) =>
                await claimCurrentRunnerManagedServiceEndpointRead({
                    authority: input.authority,
                    requestId: request.requestId,
                    projectionToken: request.projectionToken,
                    ...(request.signal ? { signal: request.signal } : {}),
                }),
            validateEndpointRead: async (request) =>
                await validateCurrentRunnerManagedServiceEndpointRead({
                    authority: input.authority,
                    daemonCapability: request.daemonCapability,
                }),
            resolveExactHandleRequestPort: () => exactHandleRequestPort,
            resolveProjectedManagedServiceRequest: (projection) => {
                const binding = input.retainedAgent;
                const contributionQualifiedId =
                    resolveAgentContributionQualifiedId({
                        pluginId: binding.pluginId,
                        localId: binding.localAgentId,
                    });
                if (
                    projection.sessionId !== input.authority.sessionId
                    || projection.pluginId !== binding.pluginId
                    || projection.contributionId
                        !== contributionQualifiedId
                    || projection.immutableGenerationId
                        !== binding.immutableGenerationId
                ) return null;
                return managedServicesOwner
                    .bindSessionManagedServiceRequest({
                        sessionId: projection.sessionId,
                        generation: binding.immutableGenerationId,
                        pluginId: projection.pluginId,
                        contributionQualifiedId:
                            projection.contributionId,
                        serviceId: projection.serverId,
                    });
            },
        });
    const durability: ManagedServiceProcessDurabilityOwner =
        Object.freeze({
            publishEndpointProjection:
                endpointProjectionBinding.publishEndpointProjection,
            releaseEndpointProjection:
                endpointProjectionBinding.releaseEndpointProjection,
            openLog: localDurability.openLog,
        });
    const unavailableDependencies = Object.freeze({
        async status(id: string) {
            return Object.freeze({
                state: 'unsupported' as const,
                id,
                code:
                    'plugin_managed_dependency_runner_unavailable',
            });
        },
        async ensure() {
            return fail(
                'plugin_managed_dependency_runner_unavailable',
                'Runner managed dependencies are unavailable',
            );
        },
        async update() {
            return fail(
                'plugin_managed_dependency_runner_unavailable',
                'Runner managed dependencies are unavailable',
            );
        },
        async remove() {
            return fail(
                'plugin_managed_dependency_runner_unavailable',
                'Runner managed dependencies are unavailable',
            );
        },
    });
    const execOwner = Object.freeze({
        async resolveExecutable() {
            return fail(
                'plugin_exec_preauthorization_required',
                'Runner managed-service launch requires exact daemon preauthorization',
            );
        },
        async resolvePath() {
            return fail(
                'plugin_exec_cwd_unavailable',
                'Runner managed-service path scope is unavailable',
            );
        },
    });
    let agentChildLaunchEnvironmentTransformer:
        ((environment: Readonly<Record<string, string>>) =>
            Readonly<Record<string, string>>) | null = null;
    const managedServiceProcessSupervisorHost =
        createManagedServiceProcessSupervisorHost({
            durability,
            custodyOwner: 'sessionRunner',
            captureProcessStartIdentity:
                observeManagedServiceProcessStartIdentity,
            transformRunnerManagedSpawnEnvironment: (environment) =>
                agentChildLaunchEnvironmentTransformer
                    ? agentChildLaunchEnvironmentTransformer(environment)
                    : environment,
            resolveRunnerPackagedRuntimeExecutable: async (executable) =>
                await resolveManagedProviderRuntimeExecutable(
                    executable,
                    {
                        retainedRunnerRuntimeIdentity:
                            input.authority.runner.snapshotIdentity,
                        runtimeModuleUrl: import.meta.url,
                    },
                ),
            async authorizeRunnerSupervision(request) {
                if (request.mode === 'externalAttach') {
                    return Object.freeze({
                        mode: 'externalAttach' as const,
                    });
                }
                const response =
                    await dispatchCurrentAgentRuntimeDaemonServiceRequest({
                        authority: input.authority,
                        signal: request.signal,
                        createRequest: (capability) => ({
                            v: 1,
                            context: {
                                token: capability,
                                sessionId:
                                    input.authority.sessionId,
                            },
                            operation: {
                                kind:
                                    'managed_server.supervision.authorize',
                                requestId: randomUUID(),
                                contributionId:
                                    request.contributionId,
                                ...(request.operationClaimId
                                    ? {
                                        operationClaimId:
                                            request.operationClaimId,
                                    }
                                    : {}),
                                serverId: request.serverId,
                                executable: request.executable,
                                environmentKeys: [
                                    ...request.environmentKeys,
                                ],
                            },
                        }),
                    });
                const authorization = requireBeforeEffect(
                    response,
                    (result) =>
                        result.kind
                            === 'managed_server.supervision'
                        && result.status === 'authorized'
                            ? Object.freeze({
                                launch: result.launch,
                            })
                            : null,
                );
                return Object.freeze({
                    mode: 'managedSpawn' as const,
                    ...authorization,
                });
            },
        });
    const loggerSink = createFilePluginInvocationLogSink();
    const secretRedactor = createPluginInvocationSecretRedactor();
    const registerRawForRedaction = (
        scope: Readonly<{
            pluginId: string;
            generation: string;
            correlationId: string;
        }>,
        value: string,
    ): void => {
        secretRedactor.registerRaw(scope, value);
    };
    /**
     * The runner is not a managed-service secret authority. It holds no
     * device-local key material and never decrypts a declared secret: every
     * read and pre-dispatch revalidation is answered by the CURRENT daemon
     * over the existing authenticated runner↔daemon services channel, from
     * that daemon's retained-generation declaration and canonical custody
     * owner. Losing daemon authority therefore yields no credential at all.
     */
    const bindManagedServiceSecretReadPort = (
        seed: PluginInvocationServicesSeed,
    ): DeclaredPluginSecretReadPort => async ({
        secretId,
        canonicalOrigin,
        signal,
    }) => {
        if (
            typeof canonicalOrigin !== 'string'
            || canonicalOrigin.length === 0
            || seed.plugin.id !== input.retainedAgent.pluginId
        ) return null;
        const isBoundCurrent = (
            revalidationSignal?: AbortSignal,
        ): boolean => (
            !signal?.aborted
            && !revalidationSignal?.aborted
            && !seed.signal.aborted
            && readsCurrent(seed.isGenerationCurrent)
        );
        if (!isBoundCurrent()) return null;
        const observed =
            await readCurrentRunnerManagedServiceDeclaredSecret({
                authority: input.authority,
                secretId,
                canonicalOrigin,
                ...(signal ? { signal } : {}),
            });
        if (!observed || !isBoundCurrent()) return null;
        if (observed.value !== null) {
            registerRawForRedaction({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            }, observed.value);
        }
        return Object.freeze({
            value: observed.value,
            revision: observed.revision,
            async isCurrent(revalidationSignal?: AbortSignal) {
                if (!isBoundCurrent(revalidationSignal)) return false;
                const current =
                    await revalidateCurrentRunnerManagedServiceDeclaredSecret({
                        authority: input.authority,
                        secretId,
                        canonicalOrigin,
                        expectedRevision: observed.revision,
                        ...(revalidationSignal
                            ? { signal: revalidationSignal }
                            : {}),
                    });
                return current && isBoundCurrent(revalidationSignal);
            },
        });
    };
    const managedServicesOwner = createManagedServicesOwner({
        processSupervisorHost: managedServiceProcessSupervisorHost,
        dependencies: unavailableDependencies,
        resolveDeclaredSecret: createDeclaredManagedServiceSecretResolver(),
        registerRawForRedaction(scope, value) {
            const correlationId = scope.operationId?.trim();
            if (!correlationId) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed-service redaction scope is unavailable',
                );
            }
            registerRawForRedaction({
                pluginId: scope.pluginId,
                generation: scope.generation,
                correlationId,
            }, value);
        },
        resolveScope(seed, context) {
            const binding = input.retainedAgent;
            const contributionQualifiedId =
                resolveAgentContributionQualifiedId({
                    pluginId: binding.pluginId,
                    localId: binding.localAgentId,
                });
            if (
                seed.pluginId !== binding.pluginId
                || seed.generation
                    !== binding.immutableGenerationId
                || seed.contributionQualifiedId
                    !== contributionQualifiedId
            ) return null;
            return Object.freeze({
                ...seed,
                ...(context?.declaredSecretReadPort
                    ? {
                        declaredSecretReadPort:
                            context.declaredSecretReadPort,
                    }
                    : {}),
                ...(seed.sessionId
                    ? { sessionId: seed.sessionId }
                    : {}),
            });
        },
    });
    const invocationLoggers = new WeakMap<
        object,
        PluginLoggerService
    >();
    const resolveLogger = (
        seed: PluginInvocationServicesSeed,
    ): PluginLoggerService => {
        let logger = invocationLoggers.get(seed);
        if (!logger) {
            logger = createPluginInvocationLogger({
                seed,
                sink: loggerSink,
                secretRedactor,
            });
            invocationLoggers.set(seed, logger);
        }
        return logger;
    };
    const approvals = createProductionPluginApprovalQueueOwner({
        recordDiagnostic(seed, error) {
            resolveLogger(seed).diagnostic({
                code: 'plugin_approval_queue_listener_failed',
                severity: 'error',
                message: error instanceof Error
                    ? error.message
                    : String(error),
            });
        },
    });
    const invocationScopes = new Map<
        string,
        Readonly<{ generation: string; pluginId: string }>
    >();
    let disposeOwnersPromise: Promise<void> | null = null;
    const owners: RunnerLocalPluginInvocationServiceOwners = Object.freeze({
        createOperationServices(seed, operation) {
            const managedServicesAvailable =
                managedServicesOwner.isAvailable({
                    generation: seed.generation,
                    contributionQualifiedId:
                        seed.contribution.qualifiedId,
                }) === true;
            const binding = addExecServiceBinding(
                createLoggerAvailablePluginInvocationServiceBinding(
                    seed.generation,
                    seed.contribution.qualifiedId,
                ),
                operation.hostAccessRequests,
                managedServicesAvailable,
            );
            const scope = Object.freeze({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            });
            secretRedactor.beginInvocation(
                scope,
                seed.redactionLifetimeSignal ?? seed.signal,
            );
            invocationScopes.set(
                `${seed.generation}\u0000${seed.plugin.id}`,
                Object.freeze({
                    generation: seed.generation,
                    pluginId: seed.plugin.id,
                }),
            );
            try {
                const services = createPluginInvocationServicesFactory({
                    loggerSink,
                    resolveLogger,
                    secretRedactor,
                    approvals,
                    exec: {
                        resolveExecutable:
                            execOwner.resolveExecutable,
                        resolvePath: async (path) =>
                            resolvePluginPathWithinRoots(
                                operation.filesystemRoots,
                                path,
                            ),
                        environment:
                            operation.environment
                            ?? Object.freeze({}),
                    },
                    managedServices: managedServicesOwner,
                    managedServiceCredentialFiles:
                        managedServiceCredentialFileOwner,
                    managedServiceDeclaredSecretReadPort: Object.freeze({
                        bind: bindManagedServiceSecretReadPort,
                    }),
                })(seed, binding);
                return Object.freeze({
                    availability: services.availability,
                    logger: services.logger,
                    sessions: services.sessions,
                    managedServices: services.managedServices,
                    targetedContributions: services.targetedContributions,
                    interactions: services.interactions,
                    composerContent: services.composerContent,
                    exec: services.exec,
                });
            } catch (error) {
                secretRedactor.completeInvocation(scope);
                throw error;
            }
        },
        registerRawForRedaction(seed, value) {
            registerRawForRedaction({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            }, value);
        },
        dispose() {
            if (disposeOwnersPromise) return disposeOwnersPromise;
            const attempt = (async () => {
                const scopes = [...invocationScopes.values()];
                invocationScopes.clear();
                for (const scope of scopes) {
                    secretRedactor.retireGeneration(
                        scope.generation,
                        scope.pluginId,
                    );
                }
                const results = await Promise.allSettled([
                    managedServicesOwner.dispose(),
                ]);
                const failures = results.flatMap((result) =>
                    result.status === 'rejected'
                        ? [result.reason]
                        : []);
                if (failures.length > 0) {
                    throw new AggregateError(
                        failures,
                        'Failed to dispose runner-local invocation service owners',
                    );
                }
            })();
            let trackedAttempt!: Promise<void>;
            trackedAttempt = attempt.catch((error: unknown) => {
                if (disposeOwnersPromise === trackedAttempt) {
                    disposeOwnersPromise = null;
                }
                throw error;
            });
            disposeOwnersPromise = trackedAttempt;
            return trackedAttempt;
        },
    });
    let currentManagedProviderBinding: Readonly<{
        scope: RunnerManagedProviderCustodyScopeV1;
        services: ManagedServices;
        requestAuth: RunnerDaemonManagedProviderBootstrapV1['requestAuth'];
        providerPluginHardRevocationRevisionAtAdmission: number;
        authority: {
            active: boolean;
            readProducerCurrent(): boolean;
        };
        isCurrent(): boolean;
    }> | null = null;
    return Object.freeze({
        owners,
        verifiedAgentDeclaration,
        bindManagedServices(bindingInput: Readonly<{
            seed: PluginInvocationServicesSeed;
            agent: Readonly<{
                exec: ExecService;
                connectedAccounts: ConnectedAccountsService;
            }>;
            managedProvider: Readonly<{
                bootstrap: RunnerDaemonManagedProviderBootstrapV1;
                exec: ExecService;
                connectedAccounts: ConnectedAccountsService;
                isCurrent(): boolean;
            }> | null;
        }>) {
            const agentServices = managedServicesOwner.bindWithExec?.(
                bindingInput.seed,
                bindingInput.agent.exec,
                Object.freeze({
                    connectedAccounts:
                        bindingInput.agent.connectedAccounts,
                    credentialFiles:
                        managedServiceCredentialFileOwner,
                    declaredSecretReadPort:
                        bindManagedServiceSecretReadPort(bindingInput.seed),
                    managedProvider: null,
                    requestAuth: null,
                }),
            ) ?? managedServicesOwner.bind(bindingInput.seed);
            const managedProvider = bindingInput.managedProvider;
            const previousBinding = currentManagedProviderBinding;
            if (!managedProvider) {
                if (previousBinding) previousBinding.authority.active = false;
                currentManagedProviderBinding = null;
                return agentServices;
            }
            const bootstrap = managedProvider.bootstrap;
            if (
                bootstrap.scope.sessionId
                    !== input.authority.sessionId
            ) {
                return fail(
                    'plugin_managed_service_unavailable',
                    'Managed Provider bootstrap belongs to another runner session',
                );
            }
            if (
                previousBinding
                && previousBinding
                    .providerPluginHardRevocationRevisionAtAdmission
                    === bootstrap
                        .providerPluginHardRevocationRevisionAtAdmission
                && isExactRunnerManagedProviderCustodyScope(
                    previousBinding.scope,
                    bootstrap.scope,
                )
            ) {
                if (!isDeepStrictEqual(
                    previousBinding.requestAuth,
                    bootstrap.requestAuth,
                )) {
                    return fail(
                        'plugin_managed_service_unavailable',
                        'Managed Provider request-auth bootstrap changed during exact-scope rebind',
                    );
                }
                // Preserve the one exact Session-P currentness cell across a
                // daemon replacement. The runner-held service and its local
                // bearer projection keep referring to this cell while B
                // remints only its live producer-currentness probe.
                previousBinding.authority.readProducerCurrent =
                    managedProvider.isCurrent;
                return agentServices;
            }
            if (previousBinding) previousBinding.authority.active = false;
            currentManagedProviderBinding = null;
            const authority = {
                active: true,
                readProducerCurrent: managedProvider.isCurrent,
            };
            const isCurrent = (): boolean => (
                authority.active
                && readsCurrent(authority.readProducerCurrent)
            );
            const services = managedServicesOwner.bindScope(
                Object.freeze({
                    generation:
                        bootstrap.scope.immutableGenerationId,
                    pluginId: bootstrap.scope.pluginId,
                    contributionQualifiedId:
                        `${bootstrap.scope.pluginId}/providers/${bootstrap.scope.providerLocalId}`,
                    sessionId: bootstrap.scope.sessionId,
                    operationId:
                        bootstrap.scope.operationClaimId,
                    signal: bindingInput.seed.signal,
                    isGenerationCurrent: isCurrent,
                }),
                managedProvider.exec,
                Object.freeze({
                    connectedAccounts:
                        managedProvider.connectedAccounts,
                    credentialFiles:
                        managedServiceCredentialFileOwner,
                    declaredSecretReadPort: null,
                    managedProvider: Object.freeze({
                        realm: 'managedProviderStart' as const,
                        providerLocalId:
                            bootstrap.scope.providerLocalId,
                        operationClaimId:
                            bootstrap.scope.operationClaimId,
                        isCurrent,
                    }),
                    requestAuth: bootstrap.requestAuth
                        ? Object.freeze({
                            realm:
                                'managedProviderStart' as const,
                            capabilityPath:
                                bootstrap.requestAuth.capabilityPath,
                            requestAuthUses: Object.freeze([
                                ...bootstrap.requestAuth
                                    .requestAuthUses,
                            ]),
                            isCurrent,
                        })
                        : null,
                }),
            );
            currentManagedProviderBinding = Object.freeze({
                scope: bootstrap.scope,
                services,
                requestAuth: bootstrap.requestAuth
                    ? Object.freeze({
                        capabilityPath:
                            bootstrap.requestAuth.capabilityPath,
                        requestAuthUses: Object.freeze(
                            bootstrap.requestAuth.requestAuthUses.map(
                                (use) => Object.freeze({
                                    ...use,
                                    materialization: Object.freeze({
                                        ...use.materialization,
                                        headerNames: Object.freeze([
                                            ...use.materialization.headerNames,
                                        ]),
                                    }),
                                }),
                            ),
                        ),
                    })
                    : null,
                providerPluginHardRevocationRevisionAtAdmission:
                    bootstrap
                        .providerPluginHardRevocationRevisionAtAdmission,
                authority,
                isCurrent,
            });
            return agentServices;
        },
        resolveAuthorizedManagedProviderServices(scope) {
            const binding = currentManagedProviderBinding;
            if (
                !binding
                || !binding.isCurrent()
                || !isExactRunnerManagedProviderCustodyScope(
                    binding.scope,
                    scope,
                )
            ) return null;
            return Object.freeze({
                services: binding.services,
                providerPluginHardRevocationRevisionAtAdmission:
                    binding
                        .providerPluginHardRevocationRevisionAtAdmission,
            });
        },
        async readCurrentProviderPluginHardRevocationRevision(pluginId) {
            return await readCurrentPluginHardRevocationRevision({
                paths: input.paths,
                pluginId,
            });
        },
        async projectManagedProviderEndpointAccess(projectInput) {
            const binding = currentManagedProviderBinding;
            const project = managedServicesOwner
                .projectManagedProviderEndpointAccess;
            if (
                !binding
                || !binding.isCurrent()
                || !isExactRunnerManagedProviderCustodyScope(
                    binding.scope,
                    projectInput.scope,
                )
                || !project
            ) return null;
            return await project({
                service: projectInput.service,
                endpoints: projectInput.endpoints,
                signal: projectInput.signal
                    ?? new AbortController().signal,
                isCurrent: () => (
                    binding.isCurrent()
                    && projectInput.isCurrent()
                ),
            });
        },
        async materializeManagedProviderAgentBinding(materializeInput) {
            const binding = currentManagedProviderBinding;
            if (
                !binding
                || !binding.isCurrent()
                || !isExactRunnerManagedProviderCustodyScope(
                    binding.scope,
                    materializeInput.scope,
                )
            ) return null;
            return await managedServicesOwner
                .materializeManagedProviderAgentBinding({
                    service: materializeInput.service,
                    projection: materializeInput.projection,
                    endpointTemplateId:
                        materializeInput.endpointTemplateId,
                    materialize:
                        materializeInput.materialize,
                });
        },
        registerAgentChildLaunchEnvironmentTransformer(transform) {
            if (agentChildLaunchEnvironmentTransformer) {
                return fail(
                    'plugin_services_managed_provider_materialization_already_attempted',
                    'Managed Provider Agent child launch transformer is already registered',
                );
            }
            agentChildLaunchEnvironmentTransformer = transform;
        },
        hostAccessRequests,
        bindAgentExternalSessionsManagedEndpoint(readInput) {
            const runnerBinding = input.retainedAgent;
            const contributionQualifiedId =
                resolveAgentContributionQualifiedId({
                    pluginId: runnerBinding.pluginId,
                    localId: runnerBinding.localAgentId,
                });
            if (
                readInput.identity.pluginId !== runnerBinding.pluginId
                || readInput.identity.agentId !== runnerBinding.localAgentId
                || readInput.identity.generation
                    !== runnerBinding.immutableGenerationId
                || readInput.identity.contributionQualifiedId
                    !== contributionQualifiedId
                || readInput.identity.immutableGenerationId
                    !== runnerBinding.immutableGenerationId
            ) {
                return fail(
                    'plugin_managed_server_endpoint_unavailable',
                    'Managed server endpoint read owner is unavailable',
                );
            }
            return endpointProjectionBinding.bindExactEndpoint({
                identity: {
                    pluginId: runnerBinding.pluginId,
                    contributionId: contributionQualifiedId,
                    sessionId: input.authority.sessionId,
                    immutableGenerationId:
                        runnerBinding.immutableGenerationId,
                },
                signal: readInput.signal,
            }) ?? fail(
                'plugin_managed_server_endpoint_unavailable',
                'Managed server endpoint read owner is unavailable',
            );
        },
        bindManagedServicesCustodyRequestPort(port) {
            if (
                exactHandleRequestPort
                && exactHandleRequestPort !== port
            ) {
                return fail(
                    'plugin_managed_server_endpoint_unavailable',
                    'Managed service exact-handle request port is already bound',
                );
            }
            exactHandleRequestPort = port;
        },
        endpointReadPort:
            endpointProjectionBinding.endpointReadPort,
        clearEndpointAuth() {
            agentChildLaunchEnvironmentTransformer = null;
            exactHandleRequestPort = null;
            endpointProjectionBinding.clearEndpointAuth();
        },
    });
}
