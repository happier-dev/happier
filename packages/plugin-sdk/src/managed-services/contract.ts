/** @moduleRealm daemon */
import {
    ManagedServiceLocalIdSchema as canonicalManagedServiceLocalIdSchema,
    type ManagedServiceLocalId,
    type PluginContributionLocalId,
} from '@happier-dev/protocol/plugins/manifest';
import type {
    ManagedExecutableRef,
    ProviderConnectionId,
} from '@happier-dev/protocol';

import type {
    ConnectedAccountMaterializationRequest,
    ConnectedAccountPurposeId,
    ConnectedAccountsService,
} from '../connectedAccounts.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type { PluginExecSpawnRequest } from '../services/io.js';
import type { HttpMethod } from '../services/io.js';

export type ProviderLocalId = PluginContributionLocalId;
export const ManagedServiceLocalIdSchema: Readonly<{
    parse(value: unknown): ManagedServiceLocalId;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ManagedServiceLocalId }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalManagedServiceLocalIdSchema;
export type { ManagedServiceLocalId };
/**
 * Canonical admission rule for an endpoint exposed by a managed or attached
 * service. Authors consume this projection instead of carrying a second URL
 * parser alongside the daemon supervisor.
 */
export { readManagedServiceEndpointUrl } from '@happier-dev/protocol';
export type {
    ManagedServiceEndpointHostPolicy,
    ManagedServiceEndpointUrlFacts,
    ManagedServiceEndpointUrlRejection,
    ManagedServiceEndpointUrlResult,
} from '@happier-dev/protocol';
export { ManagedDependencyDescriptorSchema } from '../managedDependencies.js';
export type { ManagedDependencyDescriptor } from '../managedDependencies.js';
/** @realm any */
export type {
    ManagedExecutableRef,
    PluginManagedDependencyContributionV2 as ManagedDependencyContribution,
} from '@happier-dev/protocol';
export type { ConnectedAccountMaterializationRequest } from '../connectedAccounts.js';
export type { ConnectedAccountsService } from '../connectedAccounts.js';
export type ExecSpawnRequest = PluginExecSpawnRequest;

export type ManagedDependencyStatus =
    | Readonly<{ state: 'missing'; id: PluginContributionLocalId; supported: true }>
    | Readonly<{
        state: 'ready';
        id: PluginContributionLocalId;
        version: string;
        sourceId: string;
        executable?: ManagedExecutableRef;
    }>
    | Readonly<{
        state: 'updateAvailable';
        id: PluginContributionLocalId;
        version: string;
        availableVersion: string;
        sourceId: string;
        executable?: ManagedExecutableRef;
    }>
    | Readonly<{
        state: 'unsupported' | 'failed';
        id: PluginContributionLocalId;
        code: string;
    }>;

export type ManagedDependencyReady = Extract<
    ManagedDependencyStatus,
    Readonly<{ state: 'ready' }>
>;

export interface ManagedDependenciesService {
    status(
        id: PluginContributionLocalId,
        options?: PluginCancellationOptions,
    ): Promise<ManagedDependencyStatus>;
    ensure(
        id: PluginContributionLocalId,
        options?: PluginCancellationOptions,
    ): Promise<ManagedDependencyReady>;
    update(
        id: PluginContributionLocalId,
        options?: PluginCancellationOptions,
    ): Promise<ManagedDependencyReady>;
    remove(
        id: PluginContributionLocalId,
        options?: PluginCancellationOptions,
    ): Promise<void>;
}

export type ManagedServiceClientAccess =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'hostBearer';
        injectEnvironmentKey: string;
        headerName: string;
        scheme: 'Bearer';
    }>
    | Readonly<{
        kind: 'hostBasic';
        username: string;
        injectPasswordEnvironmentKey: string;
    }>;

/**
 * Client access for a service the host attaches to rather than owns.
 *
 * A host-minted credential is meaningless here: nobody injected it into the
 * listening process. The only credential that can authenticate an attached
 * server is one its operator already chose, which the user records in a
 * settings field declared with `secret: { custody: 'daemon' }`.
 * `declaredSecretBasic` names that field; the host resolves it from the
 * daemon-local secret store, applies it to every request and to the health
 * probe, and never returns it to the plugin. The
 * plugin therefore declares *which* credential authenticates the server and
 * never handles the value, so authenticating to a server stays one host-owned
 * implementation instead of one per calling surface.
 */
export type ManagedServiceAttachClientAccess =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'declaredSecretBasic';
        /** Defaults to `''` — the empty Basic username some servers expect. */
        username?: string;
        passwordSecretId: string;
    }>;

export type ManagedServiceRequest = Readonly<{
    pathAndQuery: string;
    method?: HttpMethod;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    /**
     * Bounds request establishment through validated response headers. After
     * headers arrive, the caller signal and exact handle lifecycle own a
     * streaming response body.
     */
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

export type ManagedServiceResponse = Readonly<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: Readonly<Record<string, string>>;
    body: ReadableStream<Uint8Array> | null;
}>;

export type ManagedServiceMaterializationInjection =
    | Readonly<{
        kind: 'environment';
        targetEnvironmentKeysByMaterializedKey: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'httpHeaders';
        target: 'healthRequests' | 'providerRequests' | 'healthAndProviderRequests';
    }>
    | Readonly<{
        kind: 'files';
        pathsByFileId: Readonly<
            Record<string, Readonly<{ environmentKey: string }>>
        >;
    }>;

export type ManagedServiceCredentialBinding = Readonly<{
    purpose: ConnectedAccountPurposeId;
    request: ConnectedAccountMaterializationRequest;
    injection: ManagedServiceMaterializationInjection;
}>;

export type ManagedServiceHealthCheck =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'http';
        target?: Readonly<{ kind: 'servicePath'; path: string }>;
        headers?: Readonly<Record<string, string>>;
        timeoutMs?: number;
    }>
    | Readonly<{
        kind: 'command';
        executable: ManagedExecutableRef;
        args?: readonly string[];
        timeoutMs?: number;
    }>;

export type ManagedServiceSpec = Readonly<{
    id: ManagedServiceLocalId;
    credentialBindings?: readonly ManagedServiceCredentialBinding[];
    healthCheck?: ManagedServiceHealthCheck;
    startupTimeoutMs?: number;
    healthPolicy?: Readonly<{
        intervalMs: number;
        consecutiveFailures: number;
    }>;
}> & (
    | Readonly<{
        mode: Readonly<{
            kind: 'spawn';
            launch: ExecSpawnRequest;
            endpoint:
                | Readonly<{
                    kind: 'detectAfterLaunch';
                    minimumConfidence?: 'high' | 'medium' | 'low';
                }>
                | Readonly<{
                    kind: 'assignAndInject';
                    host?: '127.0.0.1' | '::1';
                    port:
                        | Readonly<{
                            kind: 'fixed';
                            port: number;
                            onCollision?: 'fail' | 'fallback';
                        }>
                        | Readonly<{
                            kind: 'allocated';
                            preferredPort?: number;
                            onCollision?: 'fail' | 'fallback';
                        }>;
                    inject?: Readonly<{
                        argument?: string;
                        portEnvironmentKey?: string;
                        baseUrlEnvironmentKey?: string;
                    }>;
                }>;
        }>;
        /**
         * Injects the host's existing Connected Account request-auth
         * capability document path into this owned child. The author declares
         * only the child environment destination; the host owns the path and
         * capability contents.
         */
        requestAuth?: Readonly<{
            kind: 'connectedAccountCapabilityPath';
            injectEnvironmentKey: string;
        }>;
        clientAccess?: ManagedServiceClientAccess;
        durableLog?: Readonly<{ enabled: boolean; keepCount?: number }>;
    }>
    | Readonly<{
        mode: Readonly<{ kind: 'attach'; baseUrl: string }>;
        clientAccess?: ManagedServiceAttachClientAccess;
        durableLog?: never;
    }>
);

export type ManagedServiceSnapshot = Readonly<{
    id: ManagedServiceLocalId;
    state:
        | 'starting'
        | 'detecting'
        | 'healthy'
        | 'unhealthy'
        | 'stopping'
        | 'stopped'
        | 'failed';
    mode: 'spawn' | 'attach';
    /**
     * The validated base URL required by endpoint-producing contracts such as
     * MCP discovery: a loopback `http:` address for a service the host spawned,
     * or the `http:`/`https:` address the user declared for a server they run
     * themselves. Authentication and process custody are never encoded in this
     * value.
     */
    baseUrl: string | null;
    startedAtMs: number | null;
    lastHealthyAtMs: number | null;
    diagnostics: readonly PluginDiagnosticData[];
    diagnosticsTruncated: boolean;
}>;

export interface ManagedServiceHandle extends Disposable {
    snapshot(): ManagedServiceSnapshot;
    observe(listener: (snapshot: ManagedServiceSnapshot) => void): Disposable;
    waitUntilHealthy(
        options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>,
    ): Promise<ManagedServiceSnapshot>;
    request(request: ManagedServiceRequest): Promise<ManagedServiceResponse>;
    stop(
        options?: PluginCancellationOptions,
    ): Promise<Readonly<{ status: 'stopped' | 'detached' }>>;
    dispose(): Promise<void>;
}

export interface ManagedServices {
    readonly dependencies: ManagedDependenciesService;
    supervise(
        spec: ManagedServiceSpec,
        options?: PluginCancellationOptions,
    ): Promise<ManagedServiceHandle>;
}

export type ManagedServiceErrorCode =
    | 'plugin_managed_service_spec_invalid'
    | 'plugin_managed_service_spec_conflict'
    | 'plugin_managed_service_capacity_exceeded'
    | 'plugin_managed_service_not_reusable'
    | 'plugin_managed_service_unavailable'
    | 'plugin_managed_service_establishment_failed'
    | 'plugin_managed_service_health_timeout'
    | 'plugin_operation_aborted'
    | 'plugin_managed_provider_result_invalid';

export type ManagedProviderStartRequest =
    | Readonly<{
        reason: 'explicitStartLocal';
        endpointTemplateIds: readonly ProviderLocalId[];
    }>
    | Readonly<{
        reason: 'catalogProbe' | 'sessionDemand';
        connectionId: ProviderConnectionId;
        connectionRevision: number;
        endpointTemplateIds: readonly ProviderLocalId[];
    }>;

export type ManagedProviderRuntimeContext = Readonly<{
    connectedAccounts: ConnectedAccountsService;
    managedServices: ManagedServices;
    signal: AbortSignal;
}>;

export type ManagedProviderEndpoint = Readonly<{
    service: ManagedServiceHandle;
    endpoints: readonly Readonly<{
        endpointTemplateId: ProviderLocalId;
        endpoint: Readonly<{ kind: 'servicePath'; path: string }>;
    }>[];
}>;

export interface ManagedProviderRuntime {
    start(
        request: ManagedProviderStartRequest,
        context: ManagedProviderRuntimeContext,
    ): Promise<ManagedProviderEndpoint>;
}

export interface ProvidersRegistrationApi {
    register(localId: ProviderLocalId, runtime: ManagedProviderRuntime): void;
}
