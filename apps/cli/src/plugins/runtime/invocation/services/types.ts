import type {
    HttpMethod,
    ManagedExecutableRef,
    PluginPath,
    PluginInvocationSurface,
    PluginServiceId,
    PluginServices,
} from '@happier-dev/plugin-sdk/runtime';
import type {
    PluginConnectedAccountMaterializationKind,
    PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import type {
    HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';

export type PluginInvocationServicesSeed = Readonly<{
    plugin: Readonly<{ id: string; version: string }>;
    contribution: Readonly<{ id: string; qualifiedId: string }>;
    generation: string;
    correlationId: string;
    surface: PluginInvocationSurface;
    session?: Readonly<{ id: string }>;
    currentSession?: HostCurrentSessionUiServices;
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
}>;

export type PluginMcpAuthorization = readonly Readonly<{
    serverRefs: readonly Readonly<{ pluginId: string; localId: string }>[];
    operations: readonly ('listTools' | 'callTools' | 'discover')[];
}>[];

export type PluginConnectedAccountBindingScope = Readonly<{
    purpose: string;
    serviceRefs: readonly PluginContributionIdentityV1[];
    operations: readonly ('select' | 'use')[];
    materializationKinds?: readonly PluginConnectedAccountMaterializationKind[];
}>;

export type PluginSecretBindingScope = Readonly<{
    accessId: string;
    required: boolean;
    secretIds: readonly string[];
    access: readonly ('read' | 'write' | 'delete')[];
}>;

export type PluginNetworkBindingScope = Readonly<{
    accessId: string;
    required: boolean;
    origins: readonly string[];
    methods?: readonly HttpMethod[];
    privateNetwork: boolean;
    /**
     * Present only when the host resolved a semantic connectedAccountOrigin
     * target into the concrete origins above.
     */
    connectedAccountService?: PluginContributionIdentityV1;
}>;

export type PluginSecretAccessAuthorizationEffect = Readonly<{
    pluginId: string;
    generation: string;
    secretId: string;
    access: 'status' | 'read' | 'write' | 'delete';
    scopes: readonly PluginSecretBindingScope[];
    signal?: AbortSignal;
}>;

export type AuthorizePluginSecretAccess = (
    effect: PluginSecretAccessAuthorizationEffect,
) => boolean | Promise<boolean>;

/**
 * Host-private capability token. Invocation code may verify its generation,
 * but only the host services owner interprets the binding id and service facts.
 */
export type PluginInvocationServiceBinding = Readonly<{
    kind: 'plugin_invocation_service_binding_v1';
    id: string;
    generation: string;
    availability: Readonly<Record<PluginServiceId, 'available' | 'unavailable' | 'denied'>>;
    filesystemScopes?: readonly Readonly<{ root: PluginPath['root']; projectId?: string; pathPrefix?: string; access: readonly ('read' | 'write' | 'delete')[] }>[];
    filesystemRequestIds?: readonly string[];
    processExecutables?: readonly ManagedExecutableRef[];
    processEnvKeys?: readonly string[];
    processRequestIds?: readonly string[];
    networkOrigins?: readonly string[];
    networkRequestIds?: readonly string[];
    networkScopes?: readonly PluginNetworkBindingScope[];
    /**
     * Host-owned terminal fence for bindings whose network authority depends on
     * a mutable Connected Account configuration revision.
     */
    networkCurrentness?: () => boolean | Promise<boolean>;
    mcpScopes?: PluginMcpAuthorization;
    secretScopes?: readonly PluginSecretBindingScope[];
    connectedAccountScopes?: readonly PluginConnectedAccountBindingScope[];
}>;

export type PluginFileSystemRoots = Readonly<{
    pluginData: string;
    workspace: string;
    projects: ReadonlyMap<string, string>;
}>;

export type CreatePluginInvocationServices = (
    seed: PluginInvocationServicesSeed,
    binding: PluginInvocationServiceBinding,
) => PluginServices;

export type CreateAgentInvocationServices = (
    params: Readonly<{
        pluginId: string;
        pluginVersion: string;
        agentId: string;
        generation: string;
        correlationId: string;
        cwd: string;
        environment?: Readonly<Record<string, string>>;
        providerBindingActive?: boolean;
        signal: AbortSignal;
        session?: Readonly<{
            id: string;
            current: HostCurrentSessionUiServices;
        }>;
        isGenerationCurrent(): boolean;
    }>,
) => PluginServices;

export type CreatePluginInvocationServiceBinding = (
    generation: string,
    id: string,
    hostAccessRequests?: readonly Readonly<{ request: import('@happier-dev/protocol').PluginHostAccessRequestV2; required: boolean }>[],
) => PluginInvocationServiceBinding;
