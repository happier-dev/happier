import {
    createPluginContributionIdentity,
    type ConnectedAccountPurposeDeclarationV1,
    type PluginContributionIdentityV1,
    type PluginHostAccessRequestV2,
    PluginHostAccessRequestV2Schema,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import type { ResolvedTargetAction } from '../invocation/actionExecutor';
import {
    createUnavailablePluginInvocationServiceBinding,
} from '../invocation/services/factory';
import {
    PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
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
): boolean {
    switch (request.capability) {
        case 'filesystem':
            return serviceBinding.availability.fs === 'available'
                && serviceBinding.filesystemRequestIds?.includes(request.id) === true;
        case 'process':
            return serviceBinding.availability.exec === 'available'
                && serviceBinding.processRequestIds?.includes(request.id) === true;
        case 'network':
            return serviceBinding.availability.fetch === 'available'
                && serviceBinding.networkRequestIds?.includes(request.id) === true;
        case 'secrets':
            return serviceBinding.availability.secrets === 'available';
        case 'connectedAccounts':
            return serviceBinding.availability.connectedAccounts === 'available';
        case 'sessions':
            return serviceBinding.availability.sessions === 'available';
        case 'mcp':
            return serviceBinding.availability.mcp === 'available';
        case 'network.intercept':
        case 'network.client':
        case 'environment':
        case 'terminal':
        case 'browser':
        case 'clipboard':
        case 'externalLinks':
        case 'storage.synced':
            return false;
    }
}

export function createPluginInvocationHostPolicyResolver(params?: Readonly<{
    createServiceBinding?: CreatePluginInvocationServiceBinding;
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
}>): ResolvePluginInvocationHostPolicy {
    const createServiceBinding = params?.createServiceBinding
        ?? createUnavailablePluginInvocationServiceBinding;
    return (action, context) => {
        const serviceBinding = createServiceBinding(action.generation, `${action.qualifiedId}:binding`, context.hostAccessRequests);
        const optionalAccess = params?.resolveOptionalAccess?.(action.pluginId) ?? Object.freeze([]);
        const hostAccess: TargetActionHostAccessDecision[] = context.hostAccessRequests.map(({ request, required }) => {
            const serviceAvailable = resolveServiceAvailability(request, serviceBinding);
            const selectionRequired = !required;
            const selected = isPluginHostAccessRequestAuthorizedBySelection({
                pluginId: action.pluginId,
                request,
                required,
                optionalAccess,
            });
            const status = !selected
                ? 'denied' as const
                : serviceAvailable
                    ? 'available' as const
                    : 'unavailable' as const;
            return Object.freeze({
                id: request.id,
                required,
                status,
                ...(status === 'available' ? {} : {
                    code: status === 'denied'
                        ? PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE
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
        const declaredNetworkDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'network'
        ));
        const authorizedMcpRequests = context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'mcp' && hostAccess[index]?.status === 'available'
                ? [request]
                : []
        ));
        const declaredMcpDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'mcp'
        ));
        const authorizedSecretAccessIds = new Set(context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'secrets' && hostAccess[index]?.status === 'available'
                ? [request.id]
                : []
        )));
        const declaredSecretDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'secrets'
        ));
        const authorizedConnectedAccountRequests = context.hostAccessRequests.flatMap(({ request }, index) => (
            request.capability === 'connectedAccounts' && hostAccess[index]?.status === 'available'
                ? [request]
                : []
        ));
        const declaredConnectedAccountDecisions = hostAccess.filter((_decision, index) => (
            context.hostAccessRequests[index]?.request.capability === 'connectedAccounts'
        ));
        const secretsRestrictedBinding: PluginInvocationServiceBinding = declaredSecretDecisions.length === 0
            ? withPluginInvocationServiceBindingAvailability(
                serviceBinding,
                { serviceId: 'secrets', availability: 'unavailable' },
            )
            : authorizedSecretAccessIds.size > 0
                ? Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        serviceBinding,
                        { serviceId: 'secrets', availability: 'available' },
                    ),
                    secretScopes: Object.freeze((serviceBinding.secretScopes ?? []).filter((scope) => (
                        authorizedSecretAccessIds.has(scope.accessId)
                    ))),
                })
                : withPluginInvocationServiceBindingAvailability(
                    serviceBinding,
                    {
                        serviceId: 'secrets',
                        availability: declaredSecretDecisions.some((decision) => decision.status === 'denied')
                            ? 'denied'
                            : 'unavailable',
                    },
                );
        const networkRestrictedBinding: PluginInvocationServiceBinding = declaredNetworkDecisions.length === 0
            ? withPluginInvocationServiceBindingAvailability(
                secretsRestrictedBinding,
                { serviceId: 'fetch', availability: 'unavailable' },
            )
            : authorizedNetworkAccessIds.size > 0
                ? (() => {
                    const networkScopes = Object.freeze((secretsRestrictedBinding.networkScopes ?? []).filter((scope) => (
                        authorizedNetworkAccessIds.has(scope.accessId)
                    )));
                    return Object.freeze({
                        ...withPluginInvocationServiceBindingAvailability(
                            secretsRestrictedBinding,
                            { serviceId: 'fetch', availability: 'available' },
                        ),
                        networkScopes,
                        networkRequestIds: Object.freeze(networkScopes.map((scope) => scope.accessId)),
                        networkOrigins: Object.freeze([...new Set(networkScopes.flatMap((scope) => scope.origins))].sort()),
                    });
                })()
                : withPluginInvocationServiceBindingAvailability(
                    secretsRestrictedBinding,
                    {
                        serviceId: 'fetch',
                        availability: declaredNetworkDecisions.some((decision) => decision.status === 'denied')
                            ? 'denied'
                            : 'unavailable',
                    },
                );
        const mcpRestrictedBinding: PluginInvocationServiceBinding = declaredMcpDecisions.length === 0
            ? withPluginInvocationServiceBindingAvailability(
                networkRestrictedBinding,
                { serviceId: 'mcp', availability: 'unavailable' },
            )
            : authorizedMcpRequests.length > 0
                ? Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        networkRestrictedBinding,
                        { serviceId: 'mcp', availability: 'available' },
                    ),
                    mcpScopes: Object.freeze(authorizedMcpRequests.map((request) => Object.freeze({
                        serverRefs: Object.freeze(request.scope.serverRefs.map((reference) =>
                            qualifyHostAccessContributionReference(action.pluginId, reference))),
                        operations: Object.freeze([...request.scope.operations]),
                    }))),
                })
                : withPluginInvocationServiceBindingAvailability(
                    networkRestrictedBinding,
                    {
                        serviceId: 'mcp',
                        availability: declaredMcpDecisions.some((decision) => decision.status === 'denied')
                            ? 'denied'
                            : 'unavailable',
                    },
                );
        const restrictedServiceBinding: PluginInvocationServiceBinding = declaredConnectedAccountDecisions.length === 0
            ? withPluginInvocationServiceBindingAvailability(
                mcpRestrictedBinding,
                { serviceId: 'connectedAccounts', availability: 'unavailable' },
            )
            : authorizedConnectedAccountRequests.length > 0
                ? Object.freeze({
                    ...withPluginInvocationServiceBindingAvailability(
                        mcpRestrictedBinding,
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
                    mcpRestrictedBinding,
                    {
                        serviceId: 'connectedAccounts',
                        availability: declaredConnectedAccountDecisions.some((decision) => decision.status === 'denied')
                            ? 'denied'
                            : 'unavailable',
                    },
                );
        return Object.freeze({
            hostAccess: Object.freeze(hostAccess),
            serviceBinding: restrictedServiceBinding,
        });
    };
}

export function createTargetActionHostPolicyResolver(params?: Readonly<{
    createServiceBinding?: CreatePluginInvocationServiceBinding;
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
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
    isGenerationCurrent?: (action: ResolvedTargetAction) => boolean | Promise<boolean>;
}>): ResolveTargetActionHostBinding {
    const resolvePolicy = createTargetActionHostPolicyResolver({
        ...(params?.createServiceBinding ? { createServiceBinding: params.createServiceBinding } : {}),
        ...(params?.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
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
