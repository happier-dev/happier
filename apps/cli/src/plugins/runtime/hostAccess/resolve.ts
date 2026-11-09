import type { ConnectedAccountPurposeDeclarationV1, PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import { projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
export { qualifyHostAccessContributionReference } from '@happier-dev/cli-common/connectedAccounts';
import { PluginHostAccessRequestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

import {
    PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE,
    type StablePluginAccountStorageHost,
} from '@/plugins/runtime/context/storage';
import type { ResolvedTargetAction } from '../invocation/actionExecutor';
import {
    createUnavailablePluginInvocationServiceBinding,
} from '../invocation/services/factory';
import type {
    CreatePluginInvocationServiceBinding,
    PluginInvocationServiceBinding,
} from '../invocation/services/types';
import type { TargetActionHostAccessDecision } from '../policy/evaluate';

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
    executionRealm?: 'runner' | 'background-service-process';
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
    occurrenceId: string;
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
    occurrenceId: string;
    hostAccessRequests: readonly TargetActionHostAccessRequest[];
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean | Promise<boolean>;
}>) => PluginAccountStorageScope | undefined;

export function createPluginResourceAccountStorageResolver(params: Readonly<{
    accountStorage?: StablePluginAccountStorageHost;
}>): ResolvePluginResourceAccountStorage {
    return (input) => {
        const currentness = input.isOccurrenceCurrent();
        if (input.signal.aborted || currentness === false) {
            throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin occurrenceId is stale' });
        }
        // The Account owner awaits this captured authority at every operation.
        if (typeof currentness !== 'boolean') void currentness.catch(() => undefined);
        const accountStorage = params.accountStorage?.bind({
            pluginId: input.pluginId,
            occurrenceId: input.occurrenceId,
            signal: input.signal,
            isOccurrenceCurrent: input.isOccurrenceCurrent,
        }) ?? undefined;
        if (!accountStorage && input.hostAccessRequests.some(request => request.required)) {
            throw new PluginError({
                code: PLUGIN_ACCOUNT_STORAGE_UNAVAILABLE_CODE,
                message: 'Plugin Account storage is unavailable',
            });
        }
        return accountStorage;
    };
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

/** HostAccess declarations describe consent; actual service construction owns availability. */
export function createPluginInvocationHostPolicyResolver(params?: Readonly<{
    createServiceBinding?: CreatePluginInvocationServiceBinding;
}>): ResolvePluginInvocationHostPolicy {
    const createServiceBinding = params?.createServiceBinding
        ?? createUnavailablePluginInvocationServiceBinding;
    return (action, context) => {
        const binding = createServiceBinding(
            action.occurrenceId,
            `${action.qualifiedId}:binding`,
        );
        // Purpose references select the owning Connected Account; declarations
        // do not authorize an Account, Team member or credential operation.
        const connectedAccountScopes = projectConnectedAccountHostAccessScopes(action.pluginId, context.hostAccessRequests);
        return Object.freeze({
            hostAccess: Object.freeze([]),
            serviceBinding: connectedAccountScopes.length === 0 ? binding : Object.freeze({
                ...binding,
                connectedAccountScopes,
            }),
        });
    };
}

export function createTargetActionHostPolicyResolver(params?: Readonly<{
    createServiceBinding?: CreatePluginInvocationServiceBinding;
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
    isOccurrenceCurrent?: (action: ResolvedTargetAction) => boolean | Promise<boolean>;
}>): ResolveTargetActionHostBinding {
    const resolvePolicy = createTargetActionHostPolicyResolver({
        ...(params?.createServiceBinding ? { createServiceBinding: params.createServiceBinding } : {}),
    });
    return async (action, context) => {
        if (params?.isOccurrenceCurrent && !await params.isOccurrenceCurrent(action)) {
            throw new PluginError({
                code: 'plugin_generation_stale',
                message: 'Plugin occurrenceId is stale',
            });
        }
        return resolvePolicy(action, context);
    };
}
