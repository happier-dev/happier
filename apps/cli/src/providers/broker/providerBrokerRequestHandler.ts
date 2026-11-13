import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
    ManagedProviderEndpointHttpAccess,
} from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type { ManagedServiceRequest, ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import type {
    ProviderBrokerAdmissionFailureCodeV1,
    ProviderBrokerApplicationBindingV1,
    ProviderBrokerRelayApplicationBindingV1,
    ProviderBrokerRouteGrantPayloadV1,
    PeerTcpTunnelRelayAuthorizationV2,
    SignedProviderBrokerRouteGrantV1,
    UsageObservationTokens,
} from '@happier-dev/protocol';
import type { ProviderBrokerRouteGrantExpectedBindingV1 } from '@/daemon/peer/mediation/verifyProviderBrokerRouteGrantV1';
import { evaluateTeamCredentialRequestPolicyV1, sanitizeProviderBrokerRequestV1, type TeamCredentialRequestPolicyFailureCodeV1 } from './requestPolicyV1';
import type {
    TeamCredentialProviderBrokerApplicationCarrierRequestV1,
    TeamCredentialRequestPolicyV1,
    TeamCredentialRequestProtocolKindV1,
    TeamCredentialSourceBindingV1,
    TeamCredentialSourceMemberV1,
    TeamCredentialUsageLimitDenialV1,
} from '@happier-dev/protocol/teams';
import { createExternalProviderTerminalTokenReader } from './externalProviderTerminalTokens';
import { isSameTeamCredentialBrokerApplication } from './teamCredentialModelCatalog';
import { readProviderBrokerTransportFailure } from './providerBrokerTransportFailure';
import { providerBrokerEndpointPhaseDiagnostic, runProviderBrokerApplicationPhase } from './providerBrokerApplicationFailureContext';
import { PROVIDER_BROKER_PRIVATE_CLOSE_PATH, PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH,
    PROVIDER_BROKER_MODEL_ID_HEADER, projectProviderBrokerEndpointMetadata } from './providerBrokerPrivateProtocol';
import type { SignedProviderBrokerRouteGrantV2, ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { TeamCredentialBrokerApplicationFailureCodeV1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import type { TeamCredentialBrokerSourceOpenFailureReason } from './teamCredentialBrokerSourceOwner';
import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

async function requestProviderAccess(
    access: ManagedProviderEndpointHttpAccess,
    request: ManagedServiceRequest,
): Promise<ProviderBrokerRequestHandlerResult> {
    try {
        return { ok: true, response: await access.request(request) };
    } catch (error) {
        if (error instanceof ProviderBrokerApplicationFailureError) return error.failure;
        const failure = readProviderBrokerTransportFailure(error);
        if (failure) return { ok: true, response: failure };
        throw error;
    }
}

export type ProviderBrokerRequestAdmission = Readonly<{
    authority: SignedProviderBrokerRouteGrantV1;
    streamLifetime?: ProviderBrokerApplicationStreamLifetime;
    expectedResourceRevision: number;
    expectedSourceRevision: string;
    selectedSource: TeamCredentialSourceBindingV1;
    requestId: string;
    request: ManagedServiceRequest;
    requestFacts: Readonly<{
        generation: boolean;
        routeKind: TeamCredentialRequestProtocolKindV1;
        modelId: string;
        reasoningEffort: string | null;
    }>;
}>;

export type TeamCredentialRequestModelCatalog = Readonly<{
    models: readonly Readonly<{ id: string; name?: string }>[];
    resolveCanonicalModelId(requestedModelId: string): string | null;
}>;

export type ProviderBrokerRequestPolicySnapshot = Readonly<{
    resourceRevision: number;
    sourceRevision: string;
    application: ProviderBrokerApplicationBindingV1;
    policy: TeamCredentialRequestPolicyV1 | null;
    modelCatalog: TeamCredentialRequestModelCatalog;
    source: TeamCredentialSourceBindingV1;
}>;

export type ProviderBrokerExternalRequestPolicySnapshot =
    | Readonly<{ kind: 'denied'; reasonCode: TeamCredentialRequestPolicyFailureCodeV1 | 'resource_unavailable' }>
    | (Readonly<{
        resourceRevision: number;
        policy: TeamCredentialRequestPolicyV1 | null;
        modelCatalog: TeamCredentialRequestModelCatalog;
    }> & (
        | Readonly<{ kind: 'application'; application: ProviderBrokerSourceApplicationBindingV1 }>
        | Readonly<{ kind: 'model_catalog'; applications: readonly ProviderBrokerSourceApplicationBindingV1[] }>
    ));

export type ProviderBrokerModelCatalogAuthorization =
    | Readonly<{
        kind: 'private';
        authority: SignedProviderBrokerRouteGrantV1;
    }>
    | Readonly<{
        kind: 'external_api_key';
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
        application: ProviderBrokerSourceApplicationBindingV1;
    }>
    | Readonly<{
        kind: 'resource_test';
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'resource_test' }>;
        application: ProviderBrokerSourceApplicationBindingV1;
    }>;

/** Host-private lifetime attached to one carrier-authenticated application stream. */
export type ProviderBrokerApplicationStreamLifetime = Readonly<{
    acquireSource(input: Readonly<{
        source: TeamCredentialSourceBindingV1;
        resourceId: string;
        brokerMachineId: string;
        /** The verified route grant's runtime consumer; Action operations use their own stream target. */
        operation: ProviderBrokerRouteGrantPayloadV1['consumer'];
        expectedResourceRevision: number;
        application: ProviderBrokerApplicationBindingV1;
        modelId: string;
        sourceRevision: string;
        /** The member the Home admitted this request against. */
        admittedSourceMember?: TeamCredentialSourceMemberV1;
    }>): Promise<Readonly<{ access: ManagedProviderEndpointHttpAccess; sourceMemberKey: string }>
        | Readonly<{ ok: false; reasonCode: 'resource_unavailable' | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
            sourceOpenFailureReason?: TeamCredentialBrokerSourceOpenFailureReason }> | null>;
    /** Releases this stream's joined view. The operation keeps serving its
     * other streams and the ones it has not opened yet. */
    close(): Promise<void>;
    /** The authorized explicit close: releases this stream and retires the
     * whole Session/Run operation's managed Provider custody. */
    retire(): Promise<void>;
}>;

/**
 * Facts authenticated by the carrier for exactly one admitted application
 * stream. The Home-signed authority admitted by the machine/1 handshake is
 * retained here: the Agent behind the stream holds only its loopback endpoint
 * and local capability, so no request header can supply or replace it.
 */
export type ProviderBrokerPrivateAuthenticatedStreamContext = Readonly<{
    kind?: 'private';
    authenticatedRemoteEndpointId: string;
    authority: SignedProviderBrokerRouteGrantV1;
    expected: ProviderBrokerRouteGrantExpectedBindingV1;
    /** True when the stream was admitted after its authority expired. Such a
     * stream may only retire the exact claim that authority names; every
     * other request is refused before policy, admission or source custody. */
    releaseOnly?: boolean;
    streamLifetime?: ProviderBrokerApplicationStreamLifetime;
}>;

export type ProviderBrokerExternalAuthenticatedStreamContext =
    | Readonly<{
        kind: 'external';
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
    }>
    | Readonly<{
        kind: 'external';
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'resource_test' }>;
        relayAuthorization: PeerTcpTunnelRelayAuthorizationV2;
    }>;
export type ProviderBrokerAuthenticatedStreamContext =
    | ProviderBrokerPrivateAuthenticatedStreamContext
    | ProviderBrokerExternalAuthenticatedStreamContext
    | ProviderBrokerAccountAuthenticatedStreamContext;

/** Hub catalog/admission returns the same scoped managed-service access as a
 * local consumer. The stream has no credential or catalog selection authority. */
export type ProviderBrokerAccountAuthenticatedStreamContext = Readonly<{
    kind: 'account_connection';
    authority: SignedProviderBrokerRouteGrantV2;
    authenticatedRemoteEndpointId: string;
    releaseOnly?: boolean;
    acquireSource(signal?: AbortSignal): Promise<ManagedProviderEndpointHttpAccess | null>;
    streamLifetime: Pick<ProviderBrokerApplicationStreamLifetime, 'close' | 'retire'>;
}>;

export type ProviderBrokerRequestHandlerResult =
    | Readonly<{ ok: true; response: ManagedServiceResponse }>
    | Readonly<{
        ok: false;
        reasonCode: TeamCredentialBrokerApplicationFailureCodeV1;
        usageLimit?: TeamCredentialUsageLimitDenialV1;
        sourceOpenFailureReason?: TeamCredentialBrokerSourceOpenFailureReason;
        failureCause?: ActionFailureCauseV1;
    }>;

export type ProviderBrokerRequestHandler = (input: Readonly<{
    context?: ProviderBrokerAuthenticatedStreamContext;
    carrierRequest?: TeamCredentialProviderBrokerApplicationCarrierRequestV1;
    request: ManagedServiceRequest;
}>) => Promise<ProviderBrokerRequestHandlerResult>;

type ProviderBrokerExternalTerminalUsage = Readonly<{
    requestCostParser?: import('@happier-dev/plugin-sdk/providers').ProviderRequestCostParser;
    record(input: Readonly<{
        outcome: 'succeeded' | 'failed' | 'cancelled';
        actualModelId: string | null;
        tokens: UsageObservationTokens | null;
        reportedCostUsd?: number;
    }>): Promise<void>;
}>;

function readResponseContentType(response: ManagedServiceResponse): string | null {
    const entry = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type');
    return entry ? entry[1] : null;
}

/**
 * Observes the admitted external response on the one pass it already makes for
 * the terminal outcome, so the Provider's own token fact is read without a
 * second parse of the same bytes and without buffering a response the broker is
 * only relaying. The caller still receives the Provider's exact bytes.
 */
async function observeExternalTerminalResponse(
    response: ManagedServiceResponse,
    terminalUsage: ProviderBrokerExternalTerminalUsage,
    signal: AbortSignal | undefined,
    routeKind: TeamCredentialRequestProtocolKindV1,
): Promise<ManagedServiceResponse> {
    const tokenReader = createExternalProviderTerminalTokenReader({
        routeKind,
        contentType: readResponseContentType(response),
        requestCostParser: terminalUsage.requestCostParser,
    });
    let recorded = false;
    const record = async (outcome: 'succeeded' | 'failed' | 'cancelled'): Promise<void> => {
        if (recorded) return;
        recorded = true;
        // Only a completed response can carry a truthful terminal token fact;
        // a failed or cancelled one leaves the request's usage unknown.
        const observed = outcome === 'succeeded'
            ? tokenReader.read()
            : { outcome, actualModelId: null, tokens: null };
        await terminalUsage.record(observed).catch(() => undefined);
    };
    if (!response.body) {
        await record(response.ok ? 'succeeded' : 'failed');
        return response;
    }
    const reader = response.body.getReader();
    let readerReleased = false;
    let cancellationRequested = false;
    const releaseReader = (): void => {
        if (readerReleased) return;
        readerReleased = true;
        reader.releaseLock();
    };
    return {
        ...response,
        body: new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const next = await reader.read();
                    if (next.done) {
                        controller.close();
                        releaseReader();
                        await record(response.ok ? 'succeeded' : 'failed');
                        return;
                    }
                    tokenReader.push(next.value);
                    controller.enqueue(next.value);
                } catch (error) {
                    controller.error(error);
                    releaseReader();
                    await record(cancellationRequested || signal?.aborted ? 'cancelled' : 'failed');
                }
            },
            async cancel(reason) {
                cancellationRequested = true;
                const terminalRecorded = record('cancelled');
                await reader.cancel(reason).catch(() => undefined);
                releaseReader();
                await terminalRecorded;
            },
        }),
    };
}

function routeMatchesApplicationProtocol(
    routeKind: TeamCredentialRequestProtocolKindV1,
    protocol: string,
): boolean {
    if (routeKind === 'openai_responses') return protocol === 'openai-responses';
    if (routeKind === 'openai_chat_completions') return protocol === 'openai-chat';
    return protocol === 'anthropic';
}

export function createProviderBrokerRequestHandler(input: Readonly<{
    readAdmittedRequestPolicy?(authority: ProviderBrokerRouteGrantPayloadV1): ProviderBrokerRequestPolicySnapshot | null;
    retainAdmittedRequestPolicy?(authority: ProviderBrokerRouteGrantPayloadV1, snapshot: ProviderBrokerRequestPolicySnapshot): void;
    resolveRequestPolicy: (input: Readonly<{
        authority: ProviderBrokerRouteGrantPayloadV1;
        request: ManagedServiceRequest;
    }>) => Promise<ProviderBrokerRequestPolicySnapshot | null>;
    /**
     * Checks Home job activity for private metadata-only catalog reads. This is
     * deliberately separate from effect admission so listing models cannot
     * acquire Provider credentials or create a UsageEvent.
     */
    authorizeModelCatalog?: (input: Readonly<{
        authorization: ProviderBrokerModelCatalogAuthorization;
        expectedResourceRevision: number;
        request: ManagedServiceRequest;
    }>) => Promise<Readonly<{ ok: true }> | Readonly<{
        ok: false;
        reasonCode: ProviderBrokerAdmissionFailureCodeV1;
    }>>;
    createRequestId: () => string;
    admit: (input: ProviderBrokerRequestAdmission) => Promise<Readonly<{ ok: true; access: ManagedProviderEndpointHttpAccess }> | Readonly<{ ok: false; reasonCode: ProviderBrokerAdmissionFailureCodeV1; usageLimit?: TeamCredentialUsageLimitDenialV1 }>>;
    resolveExternalRequestPolicy?: (input: Readonly<{
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
        request: ManagedServiceRequest;
    }>) => Promise<ProviderBrokerExternalRequestPolicySnapshot | null>;
    admitExternal?: (input: Readonly<{
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
        expectedResourceRevision: number;
        application: ProviderBrokerSourceApplicationBindingV1;
        request: ManagedServiceRequest;
        requestFacts: ProviderBrokerRequestAdmission['requestFacts'];
    }>) => Promise<Readonly<{
        ok: true;
        access: ManagedProviderEndpointHttpAccess;
        terminalUsage?: ProviderBrokerExternalTerminalUsage;
    }> | Readonly<{ ok: false; reasonCode: TeamCredentialBrokerApplicationFailureCodeV1; usageLimit?: TeamCredentialUsageLimitDenialV1 }>>;
    resolveResourceTestRequestPolicy?: (input: Readonly<{
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'resource_test' }>;
        request: ManagedServiceRequest;
    }>) => Promise<Readonly<{
        resourceRevision: number;
        policy: TeamCredentialRequestPolicyV1 | null;
        application: ProviderBrokerSourceApplicationBindingV1;
        modelCatalog: TeamCredentialRequestModelCatalog;
    }> | null>;
    admitResourceTest?: (input: Readonly<{
        binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'resource_test' }>;
        relayAuthorization: PeerTcpTunnelRelayAuthorizationV2;
        expectedResourceRevision: number;
        application: ProviderBrokerSourceApplicationBindingV1;
        request: ManagedServiceRequest;
        requestFacts: ProviderBrokerRequestAdmission['requestFacts'];
    }>) => Promise<Readonly<{ ok: true; access: ManagedProviderEndpointHttpAccess }> | Readonly<{ ok: false; reasonCode: TeamCredentialBrokerApplicationFailureCodeV1; usageLimit?: TeamCredentialUsageLimitDenialV1 }>>;
}>): ProviderBrokerRequestHandler {
    const modelListResponse = (
        catalog: TeamCredentialRequestModelCatalog,
        policy: TeamCredentialRequestPolicyV1 | null,
    ): ManagedServiceResponse => {
        const allowed = policy?.allowedModelIds === null || policy?.allowedModelIds === undefined
            ? null
            : new Set(policy.allowedModelIds);
        const body = new TextEncoder().encode(JSON.stringify({
            object: 'list',
            data: catalog.models
                .filter((model) => allowed === null || allowed.has(model.id))
                .map((model) => ({
                    id: model.id,
                    object: 'model',
                    created: 0,
                    owned_by: 'happier',
                    ...(model.name ? { name: model.name } : {}),
                })),
        }));
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(body);
                    controller.close();
                },
            }),
        };
    };
    return async ({ context, carrierRequest, request }) => {
        if (!context) return { ok: false, reasonCode: 'transport_identity_mismatch' };
        if (context.kind === 'account_connection') {
            if (carrierRequest || context.authenticatedRemoteEndpointId !== context.authority.payload.initiator.endpointId) {
                return { ok: false, reasonCode: 'transport_identity_mismatch' };
            }
            if (request.method === 'DELETE' && request.pathAndQuery === PROVIDER_BROKER_PRIVATE_CLOSE_PATH) {
                await context.streamLifetime.retire();
                return { ok: true, response: { ok: true, status: 204, statusText: 'No Content', headers: {}, body: null } };
            }
            if (context.releaseOnly) return { ok: false, reasonCode: 'grant_expired' };
            try {
                const sanitized = sanitizeProviderBrokerRequestV1(request);
                if (!sanitized) return { ok: false, reasonCode: 'request_malformed' };
                const access = await context.acquireSource(request.signal);
                if (!access) return { ok: false, reasonCode: 'resource_unavailable' };
                request.signal?.throwIfAborted();
                if (request.method === 'GET' && request.pathAndQuery === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
                    const response = projectProviderBrokerEndpointMetadata(
                        access.endpointUrl(context.authority.payload.application.endpointTemplateId));
                    return response ? { ok: true, response } : { ok: false, reasonCode: 'resource_unavailable' };
                }
                return await requestProviderAccess(access, sanitized);
            } catch (error) {
                if (error instanceof ProviderBrokerApplicationFailureError) return error.failure;
                return { ok: false, reasonCode: 'broker_unavailable', failureCause: projectActionFailureCauseV1(error) };
            }
        }
        if (context.kind === 'external') {
            const binding = context.binding;
            if (binding.kind === 'resource_test') {
                if (!('relayAuthorization' in context)
                    || !carrierRequest
                    || !('kind' in carrierRequest)
                    || carrierRequest.kind !== 'resource_test'
                    || carrierRequest.requestId !== binding.requestId
                    || carrierRequest.teamId !== binding.teamId
                    || carrierRequest.resourceId !== binding.resourceId
                    || !input.resolveResourceTestRequestPolicy
                    || !input.admitResourceTest) {
                    return { ok: false, reasonCode: 'transport_identity_mismatch' };
                }
                const snapshot = await input.resolveResourceTestRequestPolicy({ binding, request });
                if (!snapshot
                    || snapshot.resourceRevision !== binding.expectedResourceRevision
                    || !isSameTeamCredentialBrokerApplication(snapshot.application, binding.application)) {
                    return { ok: false, reasonCode: 'resource_unavailable' };
                }
                if (request.method === 'GET' && request.pathAndQuery === '/v1/models') {
                    if (!input.authorizeModelCatalog) return { ok: false, reasonCode: 'resource_unavailable' };
                    const authorized = await input.authorizeModelCatalog({
                        authorization: { kind: 'resource_test', binding, application: snapshot.application },
                        expectedResourceRevision: snapshot.resourceRevision,
                        request,
                    });
                    if (!authorized.ok) return authorized;
                    return { ok: true, response: modelListResponse(snapshot.modelCatalog, snapshot.policy) };
                }
                const evaluated = evaluateTeamCredentialRequestPolicyV1({
                    policy: snapshot.policy ?? {
                        allowedProtocolKinds: null, allowedModelIds: null, reasoningEffort: null,
                    },
                    request,
                    resolveCanonicalModelId: snapshot.modelCatalog.resolveCanonicalModelId,
                });
                if (!evaluated.ok) return evaluated;
                if (!routeMatchesApplicationProtocol(evaluated.routeKind, snapshot.application.protocol)) {
                    return { ok: false, reasonCode: 'route_not_allowed' };
                }
                const admitted = await input.admitResourceTest({
                    binding,
                    relayAuthorization: context.relayAuthorization,
                    expectedResourceRevision: snapshot.resourceRevision,
                    application: binding.application,
                    request: evaluated.request,
                    requestFacts: {
                        generation: evaluated.generation,
                        routeKind: evaluated.routeKind,
                        modelId: evaluated.modelId,
                        reasoningEffort: evaluated.reasoningEffort,
                    },
                });
                if (!admitted.ok) return admitted;
                return await requestProviderAccess(admitted.access, evaluated.request);
            }
            if (binding.kind !== 'external_api_key'
                || !carrierRequest
                || 'kind' in carrierRequest
                || carrierRequest.requestId !== binding.requestId
                || carrierRequest.teamId !== binding.teamId
                || carrierRequest.resourceId !== binding.resourceId
                || carrierRequest.caller.keyId !== binding.externalApiKeyId
                || carrierRequest.caller.assignedAccountId !== binding.assignedAccountId
                || carrierRequest.caller.assignedTeamMembershipId !== binding.assignedTeamMembershipId
                || !input.resolveExternalRequestPolicy
                || !input.admitExternal) {
                return { ok: false, reasonCode: 'transport_identity_mismatch' };
            }
            const snapshot = await input.resolveExternalRequestPolicy({ binding, request });
            if (!snapshot) return { ok: false, reasonCode: 'resource_unavailable' };
            if (snapshot.kind === 'denied') return { ok: false, reasonCode: snapshot.reasonCode };
            if (request.method === 'GET' && request.pathAndQuery === '/v1/models') {
                if (snapshot.kind !== 'model_catalog' || snapshot.applications.length === 0
                    || !input.authorizeModelCatalog) return { ok: false, reasonCode: 'resource_unavailable' };
                for (const application of snapshot.applications) {
                    const authorized = await input.authorizeModelCatalog({
                        authorization: { kind: 'external_api_key', binding, application },
                        expectedResourceRevision: snapshot.resourceRevision,
                        request,
                    });
                    if (!authorized.ok) return authorized;
                }
                return { ok: true, response: modelListResponse(snapshot.modelCatalog, snapshot.policy) };
            }
            if (snapshot.kind !== 'application') return { ok: false, reasonCode: 'resource_unavailable' };
            const evaluated = evaluateTeamCredentialRequestPolicyV1({
                policy: snapshot.policy ?? {
                    allowedProtocolKinds: null, allowedModelIds: null, reasoningEffort: null,
                },
                request,
                resolveCanonicalModelId: snapshot.modelCatalog.resolveCanonicalModelId,
            });
            if (!evaluated.ok) return evaluated;
            if (!routeMatchesApplicationProtocol(evaluated.routeKind, snapshot.application.protocol)) {
                return { ok: false, reasonCode: 'route_not_allowed' };
            }
            const admitted = await input.admitExternal({
                binding,
                expectedResourceRevision: snapshot.resourceRevision,
                application: snapshot.application,
                request: evaluated.request,
                requestFacts: {
                    generation: evaluated.generation,
                    routeKind: evaluated.routeKind,
                    modelId: evaluated.modelId,
                    reasoningEffort: evaluated.reasoningEffort,
                },
            });
            if (!admitted.ok) return admitted;
            try {
                const forwarded = await requestProviderAccess(admitted.access, evaluated.request);
                if (!forwarded.ok) {
                    await admitted.terminalUsage?.record({
                        outcome: evaluated.request.signal?.aborted ? 'cancelled' : 'failed',
                        actualModelId: null,
                        tokens: null,
                    }).catch(() => undefined);
                    return forwarded;
                }
                const response = forwarded.response;
                return {
                    ok: true,
                    response: admitted.terminalUsage
                        ? await observeExternalTerminalResponse(
                            response,
                            admitted.terminalUsage,
                            evaluated.request.signal,
                            evaluated.routeKind,
                        )
                        : response,
                };
            } catch (error) {
                await admitted.terminalUsage?.record({
                    outcome: evaluated.request.signal?.aborted ? 'cancelled' : 'failed',
                    actualModelId: null,
                    tokens: null,
                }).catch(() => undefined);
                throw error;
            }
        }
        // The carrier already authenticated this stream and its signed job.
        // Home decides whether the admitted job remains active per request.
        const authority = context.authority;
        const requestId = input.createRequestId();
        const phaseDiagnostic = providerBrokerEndpointPhaseDiagnostic(authority.payload, request);
        const streamLifetime = context.streamLifetime;
        const authorizeModelCatalog = input.authorizeModelCatalog;

        if (
            request.method === 'DELETE'
            && request.pathAndQuery === PROVIDER_BROKER_PRIVATE_CLOSE_PATH
        ) {
            if (!streamLifetime) {
                return { ok: false, reasonCode: 'resource_unavailable' };
            }
            await runProviderBrokerApplicationPhase('operation_close', requestId, () => streamLifetime.retire());
            return {
                ok: true,
                response: {
                    ok: true,
                    status: 204,
                    statusText: 'No Content',
                    headers: {},
                    body: null,
                },
            };
        }
        if (context.releaseOnly) return { ok: false, reasonCode: 'grant_expired' };

        const admittedPolicy = input.readAdmittedRequestPolicy?.(authority.payload);
        const policySnapshot = admittedPolicy ?? await runProviderBrokerApplicationPhase('request_policy', requestId, () =>
            input.resolveRequestPolicy({
                authority: authority.payload,
                request,
            }), phaseDiagnostic);
        if (!policySnapshot) return { ok: false, reasonCode: 'resource_unavailable' };
        // The admitted policy is retained across streams of the same signed
        // job. Home alone decides its activity against the resource revision;
        // a later catalog publication cannot replace this source snapshot.
        if (!admittedPolicy && (
            policySnapshot.sourceRevision !== authority.payload.sourceRevision
            || !isSameTeamCredentialBrokerApplication(
                policySnapshot.application,
                authority.payload.application,
            )
        )) return { ok: false, reasonCode: 'resource_changed' };
        if (request.method === 'GET' && request.pathAndQuery === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
            if (!authorizeModelCatalog || !streamLifetime) return { ok: false, reasonCode: 'resource_unavailable' };
            const requestedModel = Object.entries(request.headers ?? {})
                .find(([name]) => name.toLowerCase() === PROVIDER_BROKER_MODEL_ID_HEADER)?.[1];
            const modelId = requestedModel ? policySnapshot.modelCatalog.resolveCanonicalModelId(requestedModel) : null;
            if (!modelId || !policySnapshot.modelCatalog.models.some(model => model.id === modelId)) {
                return { ok: false, reasonCode: 'model_not_allowed' };
            }
            const authorized = await runProviderBrokerApplicationPhase('model_catalog_authorization', requestId, () =>
                authorizeModelCatalog({
                    authorization: { kind: 'private', authority },
                    expectedResourceRevision: policySnapshot.resourceRevision, request,
                }), phaseDiagnostic);
            if (!authorized.ok) return authorized;
            if (!request.signal?.aborted) input.retainAdmittedRequestPolicy?.(authority.payload, policySnapshot);
            // The exact runtime must be materialized to read its declaration.
            // Home authorizes this private metadata demand first; no inference,
            // upstream credential disclosure or UsageEvent is performed.
            const selected = await runProviderBrokerApplicationPhase('source_open', requestId, () =>
                streamLifetime.acquireSource({
                    source: policySnapshot.source, resourceId: authority.payload.resourceId,
                    brokerMachineId: authority.payload.target.machineId,
                    operation: authority.payload.consumer,
                    expectedResourceRevision: policySnapshot.resourceRevision,
                    application: authority.payload.application,
                    modelId, sourceRevision: policySnapshot.sourceRevision,
                }), phaseDiagnostic);
            if (!selected) return { ok: false, reasonCode: 'resource_unavailable' };
            if ('reasonCode' in selected) return selected;
            request.signal?.throwIfAborted();
            const response = projectProviderBrokerEndpointMetadata(selected.access.endpointUrl(
                authority.payload.application.endpointTemplateId));
            return response ? { ok: true, response } : { ok: false, reasonCode: 'resource_unavailable' };
        }
        if (request.method === 'GET' && request.pathAndQuery === '/v1/models') {
            if (!authorizeModelCatalog) return { ok: false, reasonCode: 'resource_unavailable' };
            const authorized = await runProviderBrokerApplicationPhase('model_catalog_authorization', requestId, () =>
                authorizeModelCatalog({
                    authorization: { kind: 'private', authority },
                    expectedResourceRevision: policySnapshot.resourceRevision,
                    request,
                }));
            if (!authorized.ok) return authorized;
            if (!request.signal?.aborted) input.retainAdmittedRequestPolicy?.(authority.payload, policySnapshot);
            return { ok: true, response: modelListResponse(policySnapshot.modelCatalog, policySnapshot.policy) };
        }
        const policy = policySnapshot.policy ?? {
            allowedProtocolKinds: null,
            allowedModelIds: null,
            reasoningEffort: null,
        };
        const evaluated = evaluateTeamCredentialRequestPolicyV1({
            policy,
            request,
            resolveCanonicalModelId: policySnapshot.modelCatalog.resolveCanonicalModelId,
        });
        if (!evaluated.ok) return evaluated;
        if (!routeMatchesApplicationProtocol(evaluated.routeKind, authority.payload.application.protocol)) {
            return { ok: false, reasonCode: 'route_not_allowed' };
        }

        const admitted = await runProviderBrokerApplicationPhase('home_admission', requestId, () =>
            input.admit({
                authority,
                ...(streamLifetime ? { streamLifetime } : {}),
                expectedResourceRevision: policySnapshot.resourceRevision,
                expectedSourceRevision: policySnapshot.sourceRevision,
                selectedSource: policySnapshot.source,
                requestId,
                request: evaluated.request,
                requestFacts: {
                    generation: evaluated.generation,
                    routeKind: evaluated.routeKind,
                    modelId: evaluated.modelId,
                    reasoningEffort: evaluated.reasoningEffort,
                },
            }));
        if (!admitted.ok) return admitted;
        if (!request.signal?.aborted) input.retainAdmittedRequestPolicy?.(authority.payload, policySnapshot);

        return await runProviderBrokerApplicationPhase('upstream_forward', requestId, () =>
            requestProviderAccess(admitted.access, evaluated.request));
    };
}
