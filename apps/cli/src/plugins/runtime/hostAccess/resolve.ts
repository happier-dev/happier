import {
    createPluginContributionIdentity,
    type ConnectedAccountPurposeDeclarationV1,
    type PluginContributionIdentityV1,
    type PluginHostAccessRequestV2,
    PluginHostAccessRequestV2Schema,
} from '@happier-dev/protocol';
import { PluginError, type PluginServiceId } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import {
    PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE,
    type StablePluginAccountStorageHost,
} from '@/plugins/runtime/context/storage';
import type { ResolvedTargetAction } from '../invocation/actionExecutor';
import {
    createUnavailablePluginInvocationServiceBinding,
} from '../invocation/services/factory';
import {
    PLUGIN_SERVICE_DESCRIPTORS,
    PLUGIN_SERVICE_HOST_ACCESS_DECLARATION_MISSING_CODE,
    PLUGIN_SERVICE_IDS,
    PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
    withPluginInvocationAccountStorageAvailability,
    withPluginInvocationServiceBindingUnavailableDiagnostics,
    withPluginInvocationServiceBindingAvailability,
} from '../invocation/services/unavailable';
import type {
    CreatePluginInvocationServiceBinding,
    PluginInvocationServiceBinding,
} from '../invocation/services/types';
import type { TargetActionHostAccessDecision } from '../policy/evaluate';
import { isPluginHostAccessRequestAuthorizedBySelection } from './resourceSelection';
import { fingerprintPluginHostAccessRequest } from './scope';

export type TargetActionHostAccessRequest = Readonly<{
    request: PluginHostAccessRequestV2;
    required: boolean;
}>;

export type TargetActionHostBinding = Readonly<{
    action: ResolvedTargetAction;
    serviceBinding: PluginInvocationServiceBinding;
}>;

export type TargetActionHostBindingContext = Readonly<{
    hostAccessRequests: readonly TargetActionHostAccessRequest[];
    surface: string;
    /**
     * The isolated Agent/session process, not an in-daemon background
     * service. Its finite daemon-service protocol cannot own a duplex
     * WebSocket connection.
     */
    executionRealm?: 'runner';
    sessionId?: string;
    signal?: AbortSignal;
}>;

export type ResolveTargetActionHostPolicy = (
    action: ResolvedTargetAction,
    context: TargetActionHostBindingContext,
) => TargetActionHostBinding;

export type ResolveTargetActionHostBinding = (
    action: ResolvedTargetAction,
    context: TargetActionHostBindingContext,
) => Promise<TargetActionHostBinding | null>;

export type PluginInvocationHostAccessTarget = Readonly<{
    pluginId: string;
    generation: string;
    qualifiedId: string;
}>;

export type PluginInvocationHostPolicy = Readonly<{
    hostAccess: readonly TargetActionHostAccessDecision[];
    serviceBinding: PluginInvocationServiceBinding;
}>;

export type ResolvePluginInvocationHostPolicy = (
    target: PluginInvocationHostAccessTarget,
    context: TargetActionHostBindingContext,
) => PluginInvocationHostPolicy;

export type ResolvePluginResourceAccountStorage = (input: Readonly<{
    pluginId: string;
    resourceId: string;
    generation: string;
    hostAccessRequests: readonly TargetActionHostAccessRequest[];
    signal: AbortSignal;
    isGenerationCurrent(): boolean | Promise<boolean>;
}>) => PluginAccountStorageScope | undefined;

export function createPluginResourceAccountStorageResolver(params: Readonly<{
    accountStorage?: StablePluginAccountStorageHost;
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
}>): ResolvePluginResourceAccountStorage {
    const resolvePolicy = createPluginInvocationHostPolicyResolver({
        ...(params.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
        createServiceBinding: (generation, id) => withPluginInvocationAccountStorageAvailability(
            createUnavailablePluginInvocationServiceBinding(generation, id),
            params.accountStorage ? 'available' : 'unavailable',
        ),
    });
    return (input) => {
        const currentness = input.isGenerationCurrent();
        if (input.signal.aborted || currentness === false) {
            throw new PluginError({
                code: 'plugin_generation_stale',
                message: 'Plugin generation is stale',
            });
        }
        // Resource observation is synchronous, while committed-generation
        // authority can be asynchronous. The canonical Account host awaits
        // the same stamped callback at every Account operation; observe the
        // speculative resolver check here solely to avoid an unhandled
        // rejection when no Account operation follows.
        if (typeof currentness !== 'boolean') {
            void currentness.catch(() => undefined);
        }
        if (input.hostAccessRequests.some(({ request }) => request.capability !== 'storage.account')) {
            throw new PluginError({
                code: 'plugin_resource_declaration_invalid',
                message: 'Dynamic Resource HostAccess must use Account storage',
            });
        }
        const qualifiedId = `${input.pluginId}/resources/${input.resourceId}`;
        const policy = resolvePolicy({
            pluginId: input.pluginId,
            generation: input.generation,
            qualifiedId,
        }, {
            hostAccessRequests: input.hostAccessRequests,
            surface: 'resource',
            signal: input.signal,
        });
        if (policy.hostAccess.some((decision) => decision.required && decision.status !== 'available')) {
            throw new PluginError({
                code: PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                message: 'Plugin Account storage is unavailable',
            });
        }
        if (!policy.hostAccess.some((decision) => decision.status === 'available')) return undefined;
        const accountStorage = params.accountStorage?.bind({
            pluginId: input.pluginId,
            generation: input.generation,
            signal: input.signal,
            isGenerationCurrent: input.isGenerationCurrent,
        }) ?? null;
        if (accountStorage) return accountStorage;
        if (input.hostAccessRequests.some((request) => request.required)) {
            throw new PluginError({
                code: PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                message: 'Plugin Account storage is unavailable',
            });
        }
        return undefined;
    };
}

export function qualifyHostAccessContributionReference(
    ownerPluginId: string,
    reference: ConnectedAccountPurposeDeclarationV1['service'],
): PluginContributionIdentityV1 {
    return Object.freeze(createPluginContributionIdentity(typeof reference === 'string'
        ? { pluginId: ownerPluginId, localId: reference }
        : reference));
}

/**
 * Long-lived contribution purposes use the existing HostAccess policy owner,
 * just like action/hook request ids. `required` on the purpose describes
 * whether the consumer can operate unbound; it is not a second install-time
 * permission choice, so these bounded requests are policy-required while the
 * selected account/group itself may remain absent.
 */
export function projectConnectedAccountPurposeDeclarationsToHostAccess(
    declarations: readonly ConnectedAccountPurposeDeclarationV1[],
): readonly TargetActionHostAccessRequest[] {
    return Object.freeze(declarations.map((declaration) => {
        const request = PluginHostAccessRequestV2Schema.parse({
            id: declaration.purpose,
            capability: 'connectedAccounts' as const,
            reason: 'Use the contribution-declared Connected Account purpose',
            scope: {
                serviceRefs: [declaration.service],
                operations: ['select' as const, 'use' as const],
                ...(declaration.materializationKinds !== undefined
                    ? { materializationKinds: [...declaration.materializationKinds] }
                    : {}),
            },
        });
        if (request.capability !== 'connectedAccounts') {
            throw new Error('Connected Account purpose projection produced an invalid capability');
        }
        Object.freeze(request.scope.serviceRefs);
        Object.freeze(request.scope.operations);
        if (request.scope.materializationKinds !== undefined) {
            Object.freeze(request.scope.materializationKinds);
        }
        Object.freeze(request.scope);
        return Object.freeze({
            required: true,
            request: Object.freeze(request),
        });
    }));
}

function resolveServiceAvailability(
    request: PluginHostAccessRequestV2,
    serviceBinding: PluginInvocationServiceBinding,
    sessionServiceAvailable = false,
): 'available' | 'unavailable' | 'notApplicable' {
    switch (request.capability) {
        case 'filesystem':
            return serviceBinding.availability.fs === 'available'
                && serviceBinding.filesystemRequestIds?.includes(request.id) === true
                ? 'available'
                : 'unavailable';
        case 'process':
            return serviceBinding.availability.exec === 'available'
                && serviceBinding.processRequestIds?.includes(request.id) === true
                ? 'available'
                : 'unavailable';
        case 'environment':
            return serviceBinding.availability.exec === 'available'
                && serviceBinding.environmentRequestIds?.includes(request.id) === true
                ? 'available'
                : 'unavailable';
        case 'network':
            return serviceBinding.availability.http === 'available'
                && serviceBinding.networkRequestIds?.includes(request.id) === true
                ? 'available'
                : 'unavailable';
        case 'network.client':
            return serviceBinding.availability.http === 'available'
                && serviceBinding.networkClientRequestIds?.includes(request.id) === true
                ? 'available'
                : 'unavailable';
        case 'connectedAccounts':
            return serviceBinding.availability.connectedAccounts === 'available'
                ? 'available'
                : 'unavailable';
        case 'sessions':
            return serviceBinding.availability.sessions !== 'denied'
                && (sessionServiceAvailable || serviceBinding.availability.sessions === 'available')
                ? 'available'
                : 'unavailable';
        case 'mcp':
            return serviceBinding.availability.mcp === 'available'
                ? 'available'
                : 'unavailable';
        case 'storage.account':
            return serviceBinding.accountStorageAvailability === 'available'
                ? 'available'
                : 'unavailable';
        // The Agent-session terminal really is outside an ordinary invocation's
        // topology: `terminal` HostAccess projects into the `terminalHost`
        // runtime capability that the Agent session owns.
        case 'terminal':
            return 'notApplicable';
        // Deferred: declared in the manifest catalog but with no host authority
        // or service owner behind them. `notApplicable` is treated as satisfied
        // by final policy, so returning it here would make a plugin that
        // *requires* this access look executable when the host cannot serve it.
        case 'browser':
        case 'clipboard':
        case 'externalLinks':
            return 'unavailable';
    }
}

export function createPluginInvocationHostPolicyResolver(params?: Readonly<{
    createServiceBinding?: CreatePluginInvocationServiceBinding;
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
    /** Host capacity only; the final Session service binding remains scope-gated below. */
    sessionServiceAvailable?: boolean;
}>): ResolvePluginInvocationHostPolicy {
    const createServiceBinding = params?.createServiceBinding
        ?? createUnavailablePluginInvocationServiceBinding;
    return (action, context) => {
        const serviceBinding = createServiceBinding(
            action.generation,
            `${action.qualifiedId}:binding`,
            context.hostAccessRequests,
            action.qualifiedId,
        );
        const optionalAccess = params?.resolveOptionalAccess?.(action.pluginId) ?? Object.freeze([]);
        const hostAccess: TargetActionHostAccessDecision[] = context.hostAccessRequests.map(({ request, required }) => {
            const serviceAvailability = resolveServiceAvailability(
                request,
                serviceBinding,
                params?.sessionServiceAvailable === true,
            );
            const unsupportedRunnerWebSocket = context.executionRealm === 'runner'
                && request.capability === 'network.client';
            const cooperativeAmbient = request.capability === 'filesystem'
                || request.capability === 'process'
                || request.capability === 'environment'
                || request.capability === 'network'
                || request.capability === 'network.client';
            const selectionRequired = !required && !cooperativeAmbient;
            const selected = cooperativeAmbient || isPluginHostAccessRequestAuthorizedBySelection({
                pluginId: action.pluginId,
                request,
                required,
                optionalAccess,
            });
            const status = !selected
                ? 'denied' as const
                : unsupportedRunnerWebSocket
                    ? 'unavailable' as const
                : serviceAvailability;
            return Object.freeze({
                id: request.id,
                required,
                status,
                ...(status === 'available' ? {} : {
                    code: status === 'denied'
                        ? PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE
                        : unsupportedRunnerWebSocket
                            ? 'plugin_websocket_runner_connection_protocol_unavailable'
                        : status === 'notApplicable'
                            ? 'plugin_host_access_not_applicable'
                        : 'plugin_host_access_service_unavailable',
                }),
                requestFingerprint: fingerprintPluginHostAccessRequest(request),
                ...(selectionRequired ? {
                    resourceSelection: Object.freeze({
                        requestedResourceId: fingerprintPluginHostAccessRequest(request),
                        ...(selected ? {
                            selectedResourceId: fingerprintPluginHostAccessRequest(request),
                        } : {}),
                    }),
                } : {}),
            });
        });
        const authorizedNetworkAccessIds = new Set(context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'network' && hostAccess[index]?.status === 'available'
                ? [request.id]
                : []
        )));
        const authorizedNetworkClientAccessIds = new Set(context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'network.client' && hostAccess[index]?.status === 'available'
                ? [request.id]
                : []
        )));
        const declaredNetworkDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'network'
        ));
        const declaredNetworkClientDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'network.client'
        ));
        const authorizedMcpRequests = context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'mcp' && hostAccess[index]?.status === 'available'
                ? [request]
                : []
        ));
        const declaredMcpDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'mcp'
        ));
        const authorizedSessionRequests = context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'sessions' && hostAccess[index]?.status === 'available'
                ? [request]
                : []
        ));
        const declaredSessionDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'sessions'
        ));
        const authorizedConnectedAccountRequests = context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'connectedAccounts' && hostAccess[index]?.status === 'available'
                ? [request]
                : []
        ));
        const declaredConnectedAccountDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'connectedAccounts'
        ));
        const declaredAccountStorageDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'storage.account'
        ));
        const accountStorageRestrictedBinding = withPluginInvocationAccountStorageAvailability(
            serviceBinding,
            declaredAccountStorageDecisions.some((decision) => decision.status === 'available')
                ? 'available'
                : declaredAccountStorageDecisions.some((decision) => decision.status === 'denied')
                    ? 'denied'
                    : 'unavailable',
        );
        const networkRestrictedBinding: PluginInvocationServiceBinding = declaredNetworkDecisions.length === 0
            ? accountStorageRestrictedBinding
            : authorizedNetworkAccessIds.size > 0
                ? (() => {
                    const networkScopes = Object.freeze((accountStorageRestrictedBinding.networkScopes ?? []).filter((scope) => (
                        authorizedNetworkAccessIds.has(scope.accessId)
                    )));
                    return Object.freeze({
                        ...withPluginInvocationServiceBindingAvailability(
                            accountStorageRestrictedBinding,
                            { serviceId: 'http', availability: 'available' },
                        ),
                        networkScopes,
                        networkRequestIds: Object.freeze(networkScopes.map((scope) => scope.accessId)),
                        networkOrigins: Object.freeze([...new Set(networkScopes.flatMap((scope) => scope.origins))].sort()),
                    });
                })()
                : withPluginInvocationServiceBindingAvailability(
                    accountStorageRestrictedBinding,
                    {
                        serviceId: 'http',
                        availability: declaredNetworkDecisions.some((decision) => decision.status === 'denied')
                            ? 'denied'
                            : 'unavailable',
                    },
                );
        const networkClientRestrictedBinding: PluginInvocationServiceBinding = declaredNetworkClientDecisions.length === 0
            ? networkRestrictedBinding
            : authorizedNetworkClientAccessIds.size > 0
                ? (() => {
                    const networkClientScopes = Object.freeze((networkRestrictedBinding.networkClientScopes ?? []).filter((scope) => (
                        authorizedNetworkClientAccessIds.has(scope.accessId)
                    )));
                    return Object.freeze({
                        ...withPluginInvocationServiceBindingAvailability(
                            networkRestrictedBinding,
                            { serviceId: 'http', availability: 'available' },
                        ),
                        networkClientScopes,
                        networkClientRequestIds: Object.freeze(networkClientScopes.map((scope) => scope.accessId)),
                        networkClientOrigins: Object.freeze([...new Set(networkClientScopes.flatMap((scope) => scope.origins))].sort()),
                    });
                })()
                : Object.freeze({
                    ...networkRestrictedBinding,
                    networkClientScopes: Object.freeze([]),
                    networkClientRequestIds: Object.freeze([]),
                    networkClientOrigins: Object.freeze([]),
                });
        const mcpRestrictedBinding: PluginInvocationServiceBinding = declaredMcpDecisions.length === 0
            ? withPluginInvocationServiceBindingAvailability(
                networkClientRestrictedBinding,
                { serviceId: 'mcp', availability: 'unavailable' },
            )
            : authorizedMcpRequests.length > 0
                ? Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        networkClientRestrictedBinding,
                        { serviceId: 'mcp', availability: 'available' },
                    ),
                    mcpScopes: Object.freeze(authorizedMcpRequests.map((request) => Object.freeze({
                        serverRefs: Object.freeze(request.scope.serverRefs.map((reference) =>
                            qualifyHostAccessContributionReference(action.pluginId, reference))),
                        discoverySourceRefs: Object.freeze(request.scope.discoverySourceRefs.map((reference) =>
                            qualifyHostAccessContributionReference(action.pluginId, reference))),
                        operations: Object.freeze([...request.scope.operations]),
                    }))),
                })
                : withPluginInvocationServiceBindingAvailability(
                    networkClientRestrictedBinding,
                    {
                        serviceId: 'mcp',
                        availability: declaredMcpDecisions.some((decision) => decision.status === 'denied')
                            ? 'denied'
                            : 'unavailable',
                    },
                );
        const sessionRestrictedBinding: PluginInvocationServiceBinding = declaredSessionDecisions.length === 0
            ? Object.freeze({
                ...withPluginInvocationServiceBindingAvailability(
                    mcpRestrictedBinding,
                    { serviceId: 'sessions', availability: 'unavailable' },
                ),
                sessionScopes: Object.freeze([]),
            })
            : authorizedSessionRequests.length > 0
                ? Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        mcpRestrictedBinding,
                        { serviceId: 'sessions', availability: 'available' },
                    ),
                    sessionScopes: Object.freeze(authorizedSessionRequests.map((request) => Object.freeze({
                        access: Object.freeze([...request.scope.access]),
                        ...(request.scope.machineIds === undefined
                            ? {}
                            : { machineIds: Object.freeze([...request.scope.machineIds]) }),
                        ...(request.scope.projectIds === undefined
                            ? {}
                            : { projectIds: Object.freeze([...request.scope.projectIds]) }),
                    }))),
                })
                : Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        mcpRestrictedBinding,
                        {
                            serviceId: 'sessions',
                            availability: declaredSessionDecisions.some((decision) => decision.status === 'denied')
                                ? 'denied'
                                : 'unavailable',
                        },
                    ),
                    sessionScopes: Object.freeze([]),
                });
        const restrictedServiceBinding: PluginInvocationServiceBinding = declaredConnectedAccountDecisions.length === 0
            ? withPluginInvocationServiceBindingAvailability(
                sessionRestrictedBinding,
                { serviceId: 'connectedAccounts', availability: 'unavailable' },
            )
            : authorizedConnectedAccountRequests.length > 0
                ? Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        sessionRestrictedBinding,
                        { serviceId: 'connectedAccounts', availability: 'available' },
                    ),
                    connectedAccountScopes: Object.freeze(authorizedConnectedAccountRequests.map((request) => Object.freeze({
                        purpose: request.id,
                        serviceRefs: Object.freeze(request.scope.serviceRefs.map((reference) =>
                            qualifyHostAccessContributionReference(action.pluginId, reference))),
                        operations: Object.freeze([...request.scope.operations]),
                        ...(request.scope.materializationKinds !== undefined
                            ? {
                                materializationKinds: Object.freeze([
                                    ...request.scope.materializationKinds,
                                ]),
                            }
                            : {}),
                    }))),
                })
                : withPluginInvocationServiceBindingAvailability(
                    sessionRestrictedBinding,
                    {
                        serviceId: 'connectedAccounts',
                        availability: declaredConnectedAccountDecisions.some((decision) => decision.status === 'denied')
                            ? 'denied'
                            : 'unavailable',
                    },
                );
        const declaredCapabilities = new Set<PluginHostAccessRequestV2['capability']>(
            context.hostAccessRequests.map(({ request }) => request.capability),
        );
        const unavailableDiagnostics: Partial<Record<PluginServiceId, {
            code?: string;
            requiredHostAccessCapability?: string | readonly string[];
            unavailableHostAccessCapability?: string | readonly string[];
            requiredInvocationPlacement?: 'daemon' | 'runner';
        }>> = {};
        for (const serviceId of PLUGIN_SERVICE_IDS) {
            const descriptor = PLUGIN_SERVICE_DESCRIPTORS[serviceId];
            const requiredCapability = (
                'requiredHostAccessCapability' in descriptor
                    ? descriptor.requiredHostAccessCapability
                    : undefined
            ) as PluginHostAccessRequestV2['capability']
                | readonly PluginHostAccessRequestV2['capability'][]
                | undefined;
            if (
                restrictedServiceBinding.availability[serviceId] !== 'unavailable'
                || requiredCapability === undefined
            ) continue;
            const requiredCapabilities: readonly PluginHostAccessRequestV2['capability'][] = Array.isArray(requiredCapability)
                ? requiredCapability
                : [requiredCapability];
            if (requiredCapabilities.some((capability) => declaredCapabilities.has(capability))) {
                const requiredInvocationPlacement = 'requiredInvocationPlacement' in descriptor
                    && descriptor.requiredInvocationPlacement !== undefined
                    && context.executionRealm === 'runner'
                    ? descriptor.requiredInvocationPlacement
                    : undefined;
                unavailableDiagnostics[serviceId] = {
                    unavailableHostAccessCapability: requiredCapability,
                    ...(requiredInvocationPlacement === undefined
                        ? {}
                        : { requiredInvocationPlacement }),
                };
                continue;
            }
            unavailableDiagnostics[serviceId] = {
                code: PLUGIN_SERVICE_HOST_ACCESS_DECLARATION_MISSING_CODE,
                requiredHostAccessCapability: requiredCapability,
                ...('requiredInvocationPlacement' in descriptor
                    && descriptor.requiredInvocationPlacement !== undefined
                    ? { requiredInvocationPlacement: descriptor.requiredInvocationPlacement }
                    : {}),
            };
        }
        return Object.freeze({
            hostAccess: Object.freeze(hostAccess),
            serviceBinding: withPluginInvocationServiceBindingUnavailableDiagnostics(
                restrictedServiceBinding,
                unavailableDiagnostics,
            ),
        });
    };
}

export function createTargetActionHostPolicyResolver(params?: Readonly<{
    createServiceBinding?: CreatePluginInvocationServiceBinding;
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
    sessionServiceAvailable?: boolean;
}>): ResolveTargetActionHostPolicy {
    const resolvePolicy = createPluginInvocationHostPolicyResolver(params);
    return (action, context) => {
        const resolved = resolvePolicy(action, context);
        return Object.freeze({
            action: Object.freeze({ ...action, hostAccess: resolved.hostAccess }),
            serviceBinding: resolved.serviceBinding,
        });
    };
}

export function createTargetActionHostBindingResolver(params?: Readonly<{
    createServiceBinding?: CreatePluginInvocationServiceBinding;
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
    sessionServiceAvailable?: boolean;
    isGenerationCurrent?: (action: ResolvedTargetAction) => boolean | Promise<boolean>;
}>): ResolveTargetActionHostBinding {
    const resolvePolicy = createTargetActionHostPolicyResolver({
        ...(params?.createServiceBinding ? { createServiceBinding: params.createServiceBinding } : {}),
        ...(params?.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
        ...(params?.sessionServiceAvailable === undefined
            ? {}
            : { sessionServiceAvailable: params.sessionServiceAvailable }),
    });
    return async (action, context) => {
        if (params?.isGenerationCurrent && !await params.isGenerationCurrent(action)) {
            throw new PluginError({
                code: 'plugin_generation_stale',
                message: 'Plugin generation is stale',
            });
        }
        return resolvePolicy(action, context);
    };
}
