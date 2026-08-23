import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    ConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';
import type {
    ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    ManagedServiceHandle,
    ManagedServiceRequest,
    ManagedServiceResponse,
} from '@happier-dev/plugin-sdk/managed-services';
import type {
    ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
    PluginServices,
} from '@happier-dev/plugin-sdk';

import type { DeclaredPluginSecretReadPort } from '../../context/secrets';
import type { PluginInvocationServicesSeed } from './types';

export type ManagedServiceCredentialFileCleanup = Readonly<{
    dispose(): void | Promise<void>;
}>;

export type ManagedServiceCredentialFileLease =
    ManagedServiceCredentialFileCleanup & Readonly<{
        pathsByFileId: Readonly<Record<string, string>>;
    }>;

export type ManagedServiceCredentialFileOwner = Readonly<{
    materialize(input: Readonly<{
        scope: Readonly<{
            generation: string;
            pluginId: string;
            contributionQualifiedId: string;
            sessionId?: string;
            operationId?: string;
        }>;
        files: Readonly<Record<string, Uint8Array>>;
        retainCleanup(
            cleanup: ManagedServiceCredentialFileCleanup,
        ): void;
    }>): Promise<ManagedServiceCredentialFileLease>;
}>;

/**
 * Host-private authority passed only while invoking one admitted managed
 * Provider runtime. The public spec receives only an environment destination;
 * the host retains the broker-owned path and live currentness authority.
 */
export type ManagedProviderRequestAuthCapabilityPathBinding = Readonly<{
    realm: 'managedProviderStart';
    capabilityPath: string;
    requestAuthUses: readonly ConnectedAccountRequestAuthUseV1[];
    isCurrent(): boolean;
}>;

export type ManagedProviderRuntimeInvocationBinding = Readonly<{
    realm: 'managedProviderStart';
    providerLocalId: string;
    /** Exact public-operation claim. Catalog probes use a fresh bounded id;
     * repeated explicit-start requests reuse one machine+Provider claim. */
    operationClaimId?: string;
    isCurrent(): boolean;
}>;

export type ManagedProviderRuntimeOperationBinding =
    ManagedProviderRuntimeInvocationBinding & Readonly<{
        requestAuth:
            ManagedProviderRequestAuthCapabilityPathBinding | null;
    }>;

export type ManagedProviderEndpointPath = Readonly<{
    endpointTemplateId: string;
    servicePath: string;
}>;

/**
 * Host-private projection of one admitted managed Provider endpoint.
 *
 * `endpointUrl` names the declared endpoint for contracts that must hand a URL
 * to another process. Bytes always move through `request`, which is the exact
 * `ManagedServiceHandle.request` for the supervised service: header injection,
 * credential currentness, redirect refusal and request bounding stay with that
 * one owner instead of a second transport with its own rules.
 */
export type ManagedProviderEndpointHttpAccess = Readonly<{
    endpointUrl(endpointTemplateId: string): string | null;
    request(
        request: ManagedServiceRequest & Readonly<{ timeoutMs: number }>,
    ): Promise<ManagedServiceResponse>;
}>;

export type ManagedProviderEndpointAccessProjection = Readonly<{
    access: ManagedProviderEndpointHttpAccess;
    isCurrent(): boolean;
    cleanup(): void | Promise<void>;
}>;

export type ManagedServicesInvocationBindingContext = Readonly<{
    connectedAccounts: ConnectedAccountsService | null;
    credentialFiles: ManagedServiceCredentialFileOwner | null;
    /** Exact caller-generation secret declaration/custody, if one was admitted. */
    declaredSecretReadPort: DeclaredPluginSecretReadPort | null;
    managedProvider: ManagedProviderRuntimeInvocationBinding | null;
    requestAuth: ManagedProviderRequestAuthCapabilityPathBinding | null;
}>;

export type ManagedServicesInvocationOwner = Readonly<{
    isAvailable(input: Readonly<{
        generation: string;
        contributionQualifiedId: string;
    }>): boolean;
    bind(seed: PluginInvocationServicesSeed): PluginServices['managedServices'];
    bindWithExec?(
        seed: PluginInvocationServicesSeed,
        exec: ExecService,
        context: ManagedServicesInvocationBindingContext,
    ): PluginServices['managedServices'];
    retireGeneration?(
        generation: string,
        pluginId: string,
    ): Promise<void>;
    projectManagedProviderEndpointAccess?(input: Readonly<{
        service: ManagedServiceHandle;
        endpoints: readonly ManagedProviderEndpointPath[];
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ManagedProviderEndpointAccessProjection | null>;
}>;

export function createUnavailableManagedServices(): PluginServices['managedServices'] {
    const unavailable = async (): Promise<never> => {
        throw new PluginError({
            code: 'plugin_managed_service_unavailable',
            message: 'The canonical managed-service owner is unavailable',
        });
    };
    return Object.freeze({
        dependencies: Object.freeze({
            status: unavailable,
            ensure: unavailable,
            update: unavailable,
            remove: unavailable,
        }),
        supervise: unavailable,
    });
}

export function createManagedServicesInvocationAdapter(
    owner?: ManagedServicesInvocationOwner,
): ManagedServicesInvocationOwner {
    const unavailable = createUnavailableManagedServices();
    const bindWithExec = owner?.bindWithExec;
    const retireGeneration = owner?.retireGeneration;
    const projectManagedProviderEndpointAccess =
        owner?.projectManagedProviderEndpointAccess;
    return Object.freeze({
        isAvailable(input) {
            return owner?.isAvailable(input) === true;
        },
        bind(seed) {
            return owner?.bind(seed) ?? unavailable;
        },
        ...(bindWithExec
            ? {
                bindWithExec(
                    seed: PluginInvocationServicesSeed,
                    exec: ExecService,
                    context: ManagedServicesInvocationBindingContext,
                ) {
                    return bindWithExec(seed, exec, context);
                },
            }
            : {}),
        ...(retireGeneration
            ? {
                async retireGeneration(
                    generation: string,
                    pluginId: string,
                ) {
                    await retireGeneration(generation, pluginId);
                },
            }
            : {}),
        ...(projectManagedProviderEndpointAccess
            ? {
                async projectManagedProviderEndpointAccess(input: Parameters<
                    NonNullable<ManagedServicesInvocationOwner['projectManagedProviderEndpointAccess']>
                >[0]) {
                    return await projectManagedProviderEndpointAccess(input);
                },
            }
            : {}),
    });
}
