import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    PluginError,
} from '@happier-dev/plugin-sdk';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import type {
    ActionsService } from '@happier-dev/plugin-sdk/actions';
import type {
    ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    EventsService } from '@happier-dev/plugin-sdk/events';
import type {
    ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
    HttpService } from '@happier-dev/plugin-sdk/http';
import type {
    FileSystemService } from '@happier-dev/plugin-sdk/fs';
import type {
    InteractionsService } from '@happier-dev/plugin-sdk/interactions';
import type {
    ComposerContentService,
    LoggerService as PluginLoggerService,
    PluginServiceId,
    PluginServices,
    TargetedContributionsService } from '@happier-dev/plugin-sdk';
import type {
    McpService as PluginMcpService } from '@happier-dev/plugin-sdk/mcp';
import type {
    NotificationsService as PluginNotificationsService } from '@happier-dev/plugin-sdk/notifications';
import type {
    ResourcesService as PluginResourcesService } from '@happier-dev/plugin-sdk/resources';
import type {
    SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type {
    DaemonDatabaseStorageScope,
    StorageScopeService,
    StorageService,
} from '@happier-dev/plugin-sdk/storage';
import type { ScopedSettingsService, SettingsService } from '@happier-dev/plugin-sdk/settings';
import type { ExecSystemToolServiceV1 } from '@/plugins/runtime/exec/privateContract';
import type { PluginStorePaths } from '@/plugins/store/paths';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import {
    createStablePluginStorageService,
    type StablePluginAccountStorageHost,
} from '@/plugins/runtime/context/storage';
import type { StablePluginDaemonDatabaseHost } from '@/plugins/runtime/context/daemonDatabase';
import type {
    DeclaredPluginSecretReadPort,
    StableDeclaredPluginSecretsHost,
} from '@/plugins/runtime/context/secrets';

import {
    createPluginInvocationHostEventsService,
    createPluginInvocationPluginEventsService,
    type PluginInvocationEventsHost,
} from './events';
import {
    createStablePluginExecService,
    type PluginExecDisclosureMismatch,
} from './exec';
import { createPluginFileSystemService } from './filesystem';
import {
    createPluginInvocationLogger,
    type PluginInvocationLogSink,
    type PluginInvocationSecretRedactor,
} from './logger';
import {
    createUnavailableManagedServices,
    type ManagedServiceCredentialFileOwner,
    type ManagedProviderRuntimeInvocationBinding,
    type ManagedProviderRuntimeOperationBinding,
    type ManagedServicesInvocationOwner,
} from './managedServicesAdapter';
import type { StablePluginMcpHost } from './mcp';
import type { StablePluginNotificationsOwner } from './notifications';
import type { StablePluginResourcesOwner } from './resources';
import type { StablePluginSettingsHost } from './settings';
import type { StablePluginConnectedAccountsHost } from './connectedAccounts';
import type { StableTargetedContributionsOwner } from './targetedContributions';
import type { StablePluginComposerContentOwner } from './composerContent';
import type { StablePluginHttpHost } from '../../fetch/service';
import { createPluginInteractionsService } from './interactions';
import type { StablePluginApprovalQueueOwner } from './approvalQueue';
import {
    createPluginInvocationActionsService,
    type InvokeContributedAction,
    type PluginActionsHostExecutor,
} from './actions';
import type {
    PluginAccountStorageAvailability,
    PluginFileSystemRoots,
    PluginInvocationServiceBinding,
    PluginInvocationServicesSeed,
    PluginProviderOperationsSource,
} from './types';
import {
    createExternalSessionsUnavailableCapabilities,
    type HostExternalSessionsAuthorService,
} from '@/session/external/privateContract';

export const PLUGIN_SERVICE_UNAVAILABLE_CODE = 'plugin_service_unavailable';
export const PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE = 'plugin_host_access_resource_not_selected';
export const PLUGIN_SERVICE_HOST_ACCESS_DECLARATION_MISSING_CODE = 'plugin_host_access_declaration_missing';

type PluginHostAccessCapability = PluginHostAccessRequestV2['capability'];

export type PluginServiceUnavailableDiagnostic = Readonly<{
    code?: string;
    requiredHostAccessCapability?: string | readonly string[];
    unavailableHostAccessCapability?: string | readonly string[];
    requiredInvocationPlacement?: 'daemon' | 'runner';
}>;

function formatHostAccessCapabilities(capability: string | readonly string[]): string {
    return Array.isArray(capability)
        ? capability.length === 1
            ? `'${capability[0]}'`
            : `one of ${capability.map((value) => `'${value}'`).join(', ')}`
        : `'${capability}'`;
}

function unavailableMethod(
    serviceId: PluginServiceId,
    code: string = PLUGIN_SERVICE_UNAVAILABLE_CODE,
    diagnostic?: PluginServiceUnavailableDiagnostic,
): () => never {
    return (): never => {
        const message = code === PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE
            ? `Plugin service '${serviceId}' requires a selected host resource`
            : diagnostic?.requiredHostAccessCapability !== undefined
                ? `Plugin service '${serviceId}' requires a manifest hostAccess declaration for ${formatHostAccessCapabilities(diagnostic.requiredHostAccessCapability)}`
                : diagnostic?.unavailableHostAccessCapability !== undefined
                    ? `Plugin service '${serviceId}' declares hostAccess capability ${formatHostAccessCapabilities(diagnostic.unavailableHostAccessCapability)}, but it is unavailable in the current invocation host${diagnostic.requiredInvocationPlacement === undefined
                        ? ''
                        : `; requires a ${diagnostic.requiredInvocationPlacement} invocation host`}`
                : diagnostic?.requiredInvocationPlacement !== undefined
                    ? `Plugin service '${serviceId}' requires a ${diagnostic.requiredInvocationPlacement} invocation host`
                    : `Plugin service '${serviceId}' is unavailable in the current invocation host`;
        throw new PluginError({
            code,
            message,
            details: {
                serviceId,
                ...(diagnostic?.requiredHostAccessCapability === undefined
                    ? {}
                    : { requiredHostAccessCapability: diagnostic.requiredHostAccessCapability }),
                ...(diagnostic?.unavailableHostAccessCapability === undefined
                    ? {}
                    : { unavailableHostAccessCapability: diagnostic.unavailableHostAccessCapability }),
                ...(diagnostic?.requiredInvocationPlacement === undefined
                    ? {}
                    : { requiredInvocationPlacement: diagnostic.requiredInvocationPlacement }),
            },
        });
    };
}

export function createUnavailableExternalSessionsAuthorService(
    code: string = PLUGIN_SERVICE_UNAVAILABLE_CODE,
    diagnostic?: PluginServiceUnavailableDiagnostic,
): HostExternalSessionsAuthorService {
    const fail = unavailableMethod('sessions', code, diagnostic);
    return Object.freeze({
        capabilities: async () =>
            createExternalSessionsUnavailableCapabilities(code),
        list: fail,
        attach: fail,
        readTranscript: fail,
        followTranscript: async () => Object.freeze({
            status: 'unavailable' as const,
            code,
        }),
        takeover: fail,
    });
}

function storageScope(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): StorageScopeService {
    const fail = unavailableMethod('storage', code, diagnostic);
    return Object.freeze({ get: fail, set: fail, delete: fail, consistency: fail, list: fail, transaction: fail });
}

function daemonStorageScope(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): DaemonDatabaseStorageScope {
    const scope = storageScope(code, diagnostic);
    const fail = unavailableMethod('storage', code, diagnostic);
    return Object.freeze({
        ...scope,
        database: fail,
    });
}

type PluginServiceDescriptorMap = {
    readonly [ServiceId in PluginServiceId]: Readonly<{
        id: ServiceId;
        publicProperty: ServiceId;
        availabilityOwner: 'binding' | 'host';
        /** Canonical manifest HostAccess declaration, when this service has one exact requirement. */
        requiredHostAccessCapability?: PluginHostAccessCapability | readonly PluginHostAccessCapability[];
        /** Canonical invocation placement, when the host service is placement-bound. */
        requiredInvocationPlacement?: 'daemon' | 'runner';
        unavailableCode: typeof PLUGIN_SERVICE_UNAVAILABLE_CODE;
        deniedCode: typeof PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE;
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): PluginServices[ServiceId];
        createAvailable(context: PluginInvocationServiceDescriptorContext): PluginServices[ServiceId] | null;
    }>;
};

export type PluginInvocationServicesFactoryParams = Readonly<{
    loggerSink: PluginInvocationLogSink;
    resolveLogger?: (seed: PluginInvocationServicesSeed) => PluginLoggerService;
    events?: PluginInvocationEventsHost;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    filesystemRoots?: PluginFileSystemRoots;
    resolveFilesystemRoots?: (
        seed: PluginInvocationServicesSeed,
    ) => PluginFileSystemRoots | null;
    now?: () => number;
    exec?: Readonly<{
        resolveExecutable: (
            executable: Parameters<Parameters<typeof createStablePluginExecService>[0]['resolveExecutable']>[0],
            pluginId: string,
            context?: unknown,
        ) => ReturnType<Parameters<typeof createStablePluginExecService>[0]['resolveExecutable']>;
        resolvePath: Parameters<typeof createStablePluginExecService>[0]['resolvePath'];
        environment?: Readonly<Record<string, string>>;
        agentCli?: Parameters<typeof createStablePluginExecService>[0]['agentCli'];
        systemTools?: ExecSystemToolServiceV1;
        systemToolsForPlugin?: (
            pluginId: string,
        ) => NonNullable<Parameters<typeof createStablePluginExecService>[0]['systemTools']>;
    }>;
    managedServices?: ManagedServicesInvocationOwner;
    managedServiceCredentialFiles?: ManagedServiceCredentialFileOwner;
    managedServiceDeclaredSecretReadPort?: Readonly<{
        bind(seed: PluginInvocationServicesSeed): DeclaredPluginSecretReadPort | null;
    }>;
    managedProviderRuntime?: ManagedProviderRuntimeOperationBinding;
    providers?: PluginProviderOperationsSource;
    notifications?: StablePluginNotificationsOwner;
    mcp?: StablePluginMcpHost;
    sessions?: Readonly<{
        bind(
            seed: PluginInvocationServicesSeed,
            binding: PluginInvocationServiceBinding,
            interactions: InteractionsService,
            filesystemRoots?: PluginFileSystemRoots,
        ): PluginServices['sessions'];
    }>;
    resources?: StablePluginResourcesOwner;
    settings?: StablePluginSettingsHost;
    http?: StablePluginHttpHost;
    connectedAccounts?: StablePluginConnectedAccountsHost;
    approvals?: StablePluginApprovalQueueOwner;
    actionExecutor?: PluginActionsHostExecutor;
    invokeContributedAction?: InvokeContributedAction;
    targetedContributions?: StableTargetedContributionsOwner;
    composerContent?: StablePluginComposerContentOwner;
    storagePaths?: PluginStorePaths;
    daemonDatabase?: StablePluginDaemonDatabaseHost;
    accountStorage?: StablePluginAccountStorageHost;
    secrets?: StableDeclaredPluginSecretsHost;
    secretRedactor?: PluginInvocationSecretRedactor;
}>;

type PluginInvocationServiceDescriptorContext = Readonly<{
    seed: PluginInvocationServicesSeed;
    binding: PluginInvocationServiceBinding;
    params: PluginInvocationServicesFactoryParams;
    exec: ExecService;
    execAvailable: boolean;
    connectedAccounts: ConnectedAccountsService | null;
    managedProviderRuntime: ManagedProviderRuntimeOperationBinding | null;
    interactions: InteractionsService;
    fileSystem: FileSystemService | null;
}>;

function createAvailablePluginFileSystemService(
    seed: PluginInvocationServicesSeed,
    binding: PluginInvocationServiceBinding,
    params: PluginInvocationServicesFactoryParams,
): FileSystemService | null {
    const filesystemRoots = params.filesystemRoots
        ?? params.resolveFilesystemRoots?.(seed)
        ?? null;
    if (
        binding.availability.fs !== 'available'
        || binding.filesystemScopes === undefined
        || filesystemRoots === null
    ) return null;
    const logger = params.resolveLogger?.(seed) ?? createPluginInvocationLogger({
        seed,
        sink: params.loggerSink,
        ...(params.secretRedactor ? { secretRedactor: params.secretRedactor } : {}),
        ...(params.now ? { now: params.now } : {}),
    });
    return createPluginFileSystemService({
        roots: filesystemRoots,
        scopes: binding.filesystemScopes,
        signal: seed.signal,
        isGenerationCurrent: seed.isGenerationCurrent,
        recordDisclosureMismatch: (mismatch) => {
            logger.diagnostic({
                code: 'plugin_host_access_disclosure_mismatch',
                severity: 'warning',
                message: 'Filesystem operation is outside the plugin manifest disclosure',
                details: {
                    capability: 'filesystem',
                    ...mismatch,
                },
            });
        },
    });
}

function createHostAccessDisclosureMismatchRecorder(
    seed: PluginInvocationServicesSeed,
    params: PluginInvocationServicesFactoryParams,
): (mismatch: PluginExecDisclosureMismatch) => void {
    const logger = params.resolveLogger?.(seed) ?? createPluginInvocationLogger({
        seed,
        sink: params.loggerSink,
        ...(params.secretRedactor ? { secretRedactor: params.secretRedactor } : {}),
        ...(params.now ? { now: params.now } : {}),
    });
    return (mismatch) => {
        logger.diagnostic({
            code: 'plugin_host_access_disclosure_mismatch',
            severity: 'warning',
            message: 'Process operation is outside the plugin manifest disclosure',
            details: mismatch,
        });
    };
}

/**
 * Canonical host-private roster for the public invocation service surface.
 * Public-property projection, concrete and unavailable implementations, and
 * truthful availability are derived from this table so a service cannot drift
 * between independently maintained matrices.
 */
export const PLUGIN_SERVICE_DESCRIPTORS = Object.freeze({
    logger: {
        id: 'logger', publicProperty: 'logger', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): PluginLoggerService {
            const fail = unavailableMethod('logger', code, diagnostic);
            return Object.freeze({ debug: fail, info: fail, warn: fail, error: fail, diagnostic: fail });
        },
        createAvailable({ seed, params }): PluginLoggerService {
            return params.resolveLogger?.(seed) ?? createPluginInvocationLogger({
                seed,
                sink: params.loggerSink,
                ...(params.secretRedactor ? { secretRedactor: params.secretRedactor } : {}),
                ...(params.now ? { now: params.now } : {}),
            });
        },
    },
    storage: {
        id: 'storage', publicProperty: 'storage', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): StorageService {
            return Object.freeze({
                ephemeral: storageScope(code, diagnostic),
                daemonSession: storageScope(code, diagnostic),
                daemon: daemonStorageScope(code, diagnostic),
            });
        },
        createAvailable({ seed, binding, params }): StorageService | null {
            if (binding.availability.storage === 'denied' || params.storagePaths === undefined) return null;
            return createStablePluginStorageService({
                pluginId: seed.plugin.id,
                paths: params.storagePaths,
                sessionId: seed.session?.id,
                generation: seed.generation,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
                ...(params.daemonDatabase ? { daemonDatabase: params.daemonDatabase } : {}),
                ...(binding.accountStorageCurrentness
                    ? { accountStorageCurrentness: binding.accountStorageCurrentness }
                    : {}),
                ...(binding.accountStorageAvailability === 'available' && params.accountStorage
                    ? { accountStorage: params.accountStorage }
                    : {}),
            });
        },
    },
    settings: {
        id: 'settings', publicProperty: 'settings', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): SettingsService {
            const fail = unavailableMethod('settings', code, diagnostic);
            const scoped: ScopedSettingsService = Object.freeze({
                snapshot: fail,
                get: fail,
                set: fail,
                reset: fail,
                describe: fail,
                watch: fail,
            });
            return Object.freeze({ forScope: () => scoped });
        },
        createAvailable({ seed, binding, params }): SettingsService | null {
            return binding.availability.settings !== 'denied'
                ? params.settings?.bind(seed) ?? null
                : null;
        },
    },
    secrets: {
        id: 'secrets', publicProperty: 'secrets', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): SecretsService {
            const fail = unavailableMethod('secrets', code, diagnostic);
            return Object.freeze({ status: fail, get: fail, set: fail, delete: fail });
        },
        createAvailable({ seed, params }): SecretsService | null {
            if (!params.secrets || !params.secretRedactor) return null;
            return params.secrets.bind({
                pluginId: seed.plugin.id,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
                registerRawForRedaction: (value) => params.secretRedactor!.registerRaw({
                    pluginId: seed.plugin.id,
                    generation: seed.generation,
                    correlationId: seed.correlationId,
                }, value),
            });
        },
    },
    events: {
        id: 'events', publicProperty: 'events', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): EventsService {
            const fail = unavailableMethod('events', code, diagnostic);
            return Object.freeze({
                plugin: Object.freeze({ emit: fail, subscribe: fail }),
                host: Object.freeze({ subscribe: fail }),
            });
        },
        createAvailable({ seed, params }): EventsService | null {
            if (!params.events) return null;
            return Object.freeze({
                plugin: createPluginInvocationPluginEventsService({ seed, ...params.events }),
                host: createPluginInvocationHostEventsService({ seed, broker: params.events.broker }),
            });
        },
    },
    http: {
        id: 'http', publicProperty: 'http', availabilityOwner: 'binding', requiredHostAccessCapability: ['network', 'network.client'], unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable: (code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): HttpService => Object.freeze({
            request: unavailableMethod('http', code, diagnostic),
            openWebSocket: unavailableMethod('http', code, diagnostic),
        }),
        createAvailable({ seed, binding, params }): HttpService | null {
            return binding.availability.http === 'available' && params.http !== undefined
                ? params.http.bind(seed, binding)
                : null;
        },
    },
    fs: {
        id: 'fs', publicProperty: 'fs', availabilityOwner: 'binding', requiredHostAccessCapability: 'filesystem', requiredInvocationPlacement: 'daemon', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): FileSystemService {
            const fail = unavailableMethod('fs', code, diagnostic);
            return Object.freeze({ readFile: fail, writeFile: fail, stat: fail, list: fail, remove: fail });
        },
        createAvailable({ fileSystem }): FileSystemService | null {
            return fileSystem;
        },
    },
    exec: {
        id: 'exec', publicProperty: 'exec', availabilityOwner: 'binding', requiredHostAccessCapability: ['process', 'environment'], unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): ExecService {
            const fail = unavailableMethod('exec', code, diagnostic);
            return Object.freeze({
                agentCli: Object.freeze({ checkReadiness: fail }),
                systemTools: Object.freeze({ resolve: fail }),
                run: fail,
                spawn: fail,
                clients: Object.freeze({ spawn: fail }),
            });
        },
        createAvailable({ binding, exec, execAvailable }): ExecService | null {
            return binding.availability.exec === 'available' && execAvailable ? exec : null;
        },
    },
    providers: {
        id: 'providers', publicProperty: 'providers', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): PluginServices['providers'] {
            const fail = unavailableMethod('providers', code, diagnostic);
            return Object.freeze({
                connections: Object.freeze({
                    describe: fail,
                    mutate: fail,
                    bindingStatus: fail,
                }),
                catalog: Object.freeze({
                    probe: fail,
                    listModels: fail,
                    setModelLoad: fail,
                    projectModels: fail,
                    mutateModelSettings: fail,
                }),
                migrations: Object.freeze({
                    preview: fail,
                    confirm: fail,
                    confirmConflict: fail,
                }),
            });
        },
        createAvailable({ seed, params }): PluginServices['providers'] | null {
            return params.providers?.bind({
                signal: seed.signal,
                isCurrent: seed.isGenerationCurrent,
            }) ?? null;
        },
    },
    managedServices: {
        id: 'managedServices', publicProperty: 'managedServices', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(_code?: string, _diagnostic?: PluginServiceUnavailableDiagnostic): PluginServices['managedServices'] {
            return createUnavailableManagedServices();
        },
        createAvailable({ seed, binding, params, exec, connectedAccounts, managedProviderRuntime }): PluginServices['managedServices'] | null {
            return binding.availability.managedServices === 'available'
                && params.managedServices !== undefined
                ? params.managedServices.bindWithExec?.(seed, exec, Object.freeze({
                    connectedAccounts,
                    credentialFiles:
                        params.managedServiceCredentialFiles ?? null,
                    declaredSecretReadPort:
                        params.managedServiceDeclaredSecretReadPort?.bind(seed)
                        ?? null,
                    managedProvider: managedProviderRuntime
                        ? Object.freeze({
                            realm: managedProviderRuntime.realm,
                            providerLocalId:
                                managedProviderRuntime.providerLocalId,
                            ...(managedProviderRuntime.operationClaimId
                                === undefined
                                ? {}
                                : {
                                    operationClaimId:
                                        managedProviderRuntime
                                            .operationClaimId,
                                }),
                            isCurrent:
                                managedProviderRuntime.isCurrent,
                        })
                        : null,
                    requestAuth:
                        managedProviderRuntime?.requestAuth ?? null,
                }))
                    ?? params.managedServices.bind(seed)
                : null;
        },
    },
    sessions: {
        id: 'sessions', publicProperty: 'sessions', availabilityOwner: 'binding', requiredHostAccessCapability: 'sessions', requiredInvocationPlacement: 'daemon', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): PluginServices['sessions'] {
            const fail = unavailableMethod('sessions', code, diagnostic);
            return Object.freeze({
                current: null,
                list: fail, get: fail, watch: fail,
                subagents: Object.freeze({ capabilities: fail, list: fail, get: fail, observe: fail, watch: fail }),
                external: createUnavailableExternalSessionsAuthorService(code, diagnostic),
            });
        },
        createAvailable({ seed, binding, params, interactions }): PluginServices['sessions'] | null {
            return binding.availability.sessions === 'available' && params.sessions !== undefined
                ? params.sessions.bind(seed, binding, interactions, params.filesystemRoots)
                : null;
        },
    },
    resources: {
        id: 'resources', publicProperty: 'resources', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): PluginResourcesService {
            const fail = unavailableMethod('resources', code, diagnostic);
            return Object.freeze({ describe: fail, read: fail, watch: fail });
        },
        createAvailable({ seed, binding, params }): PluginResourcesService | null {
            if (
                binding.availability.resources === 'denied'
                || params.resources === undefined
                || !params.resources.hasPlugin(seed.plugin.id)
            ) return null;
            return params.resources.bind({
                pluginId: seed.plugin.id,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            });
        },
    },
    mcp: {
        id: 'mcp', publicProperty: 'mcp', availabilityOwner: 'binding', requiredHostAccessCapability: 'mcp', requiredInvocationPlacement: 'daemon', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): PluginMcpService {
            const fail = unavailableMethod('mcp', code, diagnostic);
            return Object.freeze({
                list: async () => fail(),
                connect: async () => fail(),
                discover: async () => fail(),
            });
        },
        createAvailable({ seed, binding, params }): PluginMcpService | null {
            return binding.availability.mcp === 'available' && params.mcp !== undefined
                ? params.mcp.bind(seed, binding.mcpScopes)
                : null;
        },
    },
    notifications: {
        id: 'notifications', publicProperty: 'notifications', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): PluginNotificationsService {
            const fail = unavailableMethod('notifications', code, diagnostic);
            return Object.freeze({ send: fail, listChannels: fail, listCategories: fail, preferences: fail, watchPreferences: fail });
        },
        createAvailable({ seed, binding, params }): PluginNotificationsService | null {
            return binding.availability.notifications !== 'denied' && params.notifications !== undefined
                ? params.notifications.bind(seed)
                : null;
        },
    },
    connectedAccounts: {
        id: 'connectedAccounts', publicProperty: 'connectedAccounts', availabilityOwner: 'binding', requiredHostAccessCapability: 'connectedAccounts', requiredInvocationPlacement: 'daemon', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): ConnectedAccountsService {
            const fail = unavailableMethod('connectedAccounts', code, diagnostic);
            return Object.freeze({
                getBinding: fail,
                requestSelection: fail,
                materialize: fail,
                listAccounts: fail,
                materializeListedAccount: fail,
                watch: fail,
            });
        },
        createAvailable({ connectedAccounts }): ConnectedAccountsService | null {
            return connectedAccounts;
        },
    },
    actions: {
        id: 'actions', publicProperty: 'actions', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): ActionsService {
            const fail = unavailableMethod('actions', code, diagnostic);
            return Object.freeze({
                execute: fail,
                executeAdmittedTargetedOperation: fail,
                executeWithExecutionOrigin: fail,
                executeAdmittedTargetedOperationWithExecutionOrigin: fail,
            }) as ActionsService;
        },
        createAvailable({ seed, params }): ActionsService | null {
            if (params.actionExecutor === undefined || params.invokeContributedAction === undefined) return null;
            return createPluginInvocationActionsService({
                seed: Object.freeze({
                    plugin: seed.plugin,
                    contribution: seed.contribution,
                    generation: seed.generation,
                    ...(seed.immutableGenerationId === undefined
                        ? {}
                        : { immutableGenerationId: seed.immutableGenerationId }),
                    correlationId: seed.correlationId,
                    surface: seed.surface,
                    ...(seed.caller ? { caller: seed.caller } : {}),
                    ...(seed.resolveCurrentPluginMaterializationRef
                        ? {
                            resolveCurrentPluginMaterializationRef:
                                seed.resolveCurrentPluginMaterializationRef,
                        }
                        : {}),
                    ...(seed.selectedActionInputCarrier
                        ? { selectedActionInputCarrier: seed.selectedActionInputCarrier }
                        : {}),
                    ...(seed.isMountedCallerCurrent
                        ? { isMountedCallerCurrent: seed.isMountedCallerCurrent }
                        : {}),
                    ...(seed.session ? { session: seed.session } : {}),
                    signal: seed.signal,
                    isGenerationCurrent: seed.isGenerationCurrent,
                    ...(seed.bypassActionInterception === true
                        ? { bypassActionInterception: true as const }
                        : {}),
                }),
                actionExecutor: params.actionExecutor,
                invokeContributedAction: params.invokeContributedAction,
            });
        },
    },
    targetedContributions: {
        id: 'targetedContributions', publicProperty: 'targetedContributions', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string, diagnostic?: PluginServiceUnavailableDiagnostic): TargetedContributionsService {
            const fail = unavailableMethod('targetedContributions', code, diagnostic);
            return Object.freeze({ observeForSelf: fail });
        },
        createAvailable({ seed, params }): TargetedContributionsService | null {
            return params.targetedContributions?.bind({
                pluginId: seed.plugin.id,
                signal: seed.signal,
                isCurrent: seed.isGenerationCurrent,
            }) ?? null;
        },
    },
    composerContent: {
        id: 'composerContent', publicProperty: 'composerContent', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code: string = PLUGIN_SERVICE_UNAVAILABLE_CODE, diagnostic?: PluginServiceUnavailableDiagnostic): ComposerContentService {
            const fail = unavailableMethod('composerContent', code, diagnostic);
            return Object.freeze({
                capabilities: () => Object.freeze({
                    [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: Object.freeze({
                        status: code === PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE
                            ? 'denied' as const
                            : 'unavailable' as const,
                        code,
                    }),
                }),
                stageMedia: fail,
            });
        },
        createAvailable({ seed, params, fileSystem }): ComposerContentService | null {
            return fileSystem ? params.composerContent?.bind({ seed, fileSystem }) ?? null : null;
        },
    },
    interactions: {
        id: 'interactions', publicProperty: 'interactions', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(_code?: string): InteractionsService {
            const controller = new AbortController();
            return createPluginInteractionsService({
                currentSession: null,
                signal: controller.signal,
                isGenerationCurrent: () => true,
            });
        },
        createAvailable({ interactions }): InteractionsService {
            return interactions;
        },
    },
} satisfies PluginServiceDescriptorMap);

export const PLUGIN_SERVICE_IDS = Object.freeze(
    Object.keys(PLUGIN_SERVICE_DESCRIPTORS) as PluginServiceId[],
);

export type PluginServiceBindingAvailability = 'available' | 'unavailable' | 'denied';

export function createPluginInvocationServiceBinding(
    generation: string,
    id: string,
): PluginInvocationServiceBinding {
    return Object.freeze({
        kind: 'plugin_invocation_service_binding_v1',
        id,
        generation,
        availability: Object.freeze(Object.fromEntries(
            PLUGIN_SERVICE_IDS.map((serviceId) => [
                PLUGIN_SERVICE_DESCRIPTORS[serviceId].id,
                'unavailable' as const,
            ]),
        ) as Record<PluginServiceId, 'unavailable'>),
        accountStorageAvailability: 'unavailable',
    });
}

export function withPluginInvocationServiceBindingAvailability(
    binding: PluginInvocationServiceBinding,
    ...changes: readonly Readonly<{
        serviceId: PluginServiceId;
        availability: PluginServiceBindingAvailability;
    }>[]
): PluginInvocationServiceBinding {
    if (changes.length === 0) return binding;
    const availability: Record<PluginServiceId, PluginServiceBindingAvailability> = {
        ...binding.availability,
    };
    for (const change of changes) {
        availability[PLUGIN_SERVICE_DESCRIPTORS[change.serviceId].id] = change.availability;
    }
    return Object.freeze({
        ...binding,
        availability: Object.freeze(availability),
    });
}

export function withPluginInvocationServiceBindingUnavailableDiagnostics(
    binding: PluginInvocationServiceBinding,
    diagnostics: Readonly<Partial<Record<PluginServiceId, PluginServiceUnavailableDiagnostic>>>,
): PluginInvocationServiceBinding {
    if (Object.keys(diagnostics).length === 0) return binding;
    return Object.freeze({
        ...binding,
        unavailableDiagnostics: Object.freeze({
            ...(binding.unavailableDiagnostics ?? {}),
            ...diagnostics,
        }),
    });
}

export function withPluginInvocationAccountStorageAvailability(
    binding: PluginInvocationServiceBinding,
    availability: PluginAccountStorageAvailability,
): PluginInvocationServiceBinding {
    return binding.accountStorageAvailability === availability
        ? binding
        : Object.freeze({
            ...binding,
            accountStorageAvailability: availability,
        });
}

export function createUnavailablePluginServices(params?: Readonly<{
    deniedServiceIds?: readonly PluginServiceId[];
    unavailableDiagnostics?: Readonly<Partial<Record<PluginServiceId, PluginServiceUnavailableDiagnostic>>>;
}>): PluginServices {
    const deniedServiceIds = new Set(params?.deniedServiceIds ?? []);
    const unavailableDiagnostics: Readonly<Partial<Record<PluginServiceId, PluginServiceUnavailableDiagnostic>>> =
        params?.unavailableDiagnostics ?? Object.freeze({});
    const services = Object.fromEntries(PLUGIN_SERVICE_IDS.map((serviceId) => [
        PLUGIN_SERVICE_DESCRIPTORS[serviceId].publicProperty,
        PLUGIN_SERVICE_DESCRIPTORS[serviceId].createUnavailable(
            deniedServiceIds.has(serviceId)
                ? PLUGIN_SERVICE_DESCRIPTORS[serviceId].deniedCode
                : unavailableDiagnostics[serviceId]?.code,
            deniedServiceIds.has(serviceId) ? undefined : unavailableDiagnostics[serviceId],
        ),
    ])) as Omit<PluginServices, 'availability'>;
    return Object.freeze({
        availability: (serviceId: PluginServiceId) => deniedServiceIds.has(serviceId)
            ? Object.freeze({
                status: 'denied' as const,
                code: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
            })
            : Object.freeze({
                status: 'unavailable' as const,
                code: unavailableDiagnostics[serviceId]?.code
                    ?? PLUGIN_SERVICE_UNAVAILABLE_CODE,
            }),
        ...services,
    });
}

export function createPluginInvocationServicesFromDescriptors(
    seed: PluginInvocationServicesSeed,
    binding: PluginInvocationServiceBinding,
    params: PluginInvocationServicesFactoryParams,
): PluginServices {
    if (binding.generation !== seed.generation) {
        throw new Error('Plugin invocation service binding generation does not match the invocation context');
    }
    const unavailable = createUnavailablePluginServices({
        deniedServiceIds: PLUGIN_SERVICE_IDS.filter((serviceId) => binding.availability[serviceId] === 'denied'),
        unavailableDiagnostics: binding.unavailableDiagnostics,
    });
    const configuredManagedProvider = params.managedProviderRuntime;
    const managedProviderRuntime = configuredManagedProvider
        && configuredManagedProvider.realm === 'managedProviderStart'
        && configuredManagedProvider.providerLocalId.trim().length > 0
        && seed.contribution.qualifiedId
            === `${seed.plugin.id}/providers/${configuredManagedProvider.providerLocalId}`
        ? Object.freeze({
            realm: 'managedProviderStart' as const,
            providerLocalId: configuredManagedProvider.providerLocalId,
            ...(configuredManagedProvider.operationClaimId === undefined
                ? {}
                : {
                    operationClaimId:
                        configuredManagedProvider.operationClaimId,
                }),
            requestAuth: configuredManagedProvider.requestAuth
                ? Object.freeze({
                    ...configuredManagedProvider.requestAuth,
                    isCurrent: () => (
                        seed.isGenerationCurrent()
                        && configuredManagedProvider.isCurrent()
                        && configuredManagedProvider.requestAuth!.isCurrent()
                    ),
                })
                : null,
            isCurrent: () => (
                seed.isGenerationCurrent()
                && configuredManagedProvider.isCurrent()
            ),
        }) satisfies ManagedProviderRuntimeOperationBinding
        : null;
    const execAvailable = binding.processExecutables !== undefined && params.exec !== undefined;
    const exec = execAvailable
        ? createStablePluginExecService({
            allowedExecutables: binding.processExecutables!,
            allowedEnvKeys: binding.processEnvKeys,
            allowedCwdScopes: binding.filesystemScopes,
            signal: seed.signal,
            isGenerationCurrent: seed.isGenerationCurrent,
            resolveExecutable: (executable) => params.exec!.resolveExecutable(
                executable,
                seed.plugin.id,
                managedProviderRuntime
                    ? Object.freeze({
                        kind: 'managedProviderRuntime' as const,
                        pluginId: seed.plugin.id,
                        providerLocalId:
                            managedProviderRuntime.providerLocalId,
                        contributionQualifiedId:
                            seed.contribution.qualifiedId,
                        generation: seed.generation,
                        isCurrent: managedProviderRuntime.isCurrent,
                    })
                    : undefined,
            ),
            resolvePath: params.exec!.resolvePath,
            recordDisclosureMismatch: createHostAccessDisclosureMismatchRecorder(seed, params),
            ...(params.exec!.agentCli ? { agentCli: params.exec!.agentCli } : {}),
            ...(params.exec!.systemTools
                ? { systemTools: params.exec!.systemTools }
                : params.exec!.systemToolsForPlugin
                ? { systemTools: params.exec!.systemToolsForPlugin(seed.plugin.id) }
                : {}),
            ...(params.exec!.environment ? { environment: params.exec!.environment } : {}),
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        })
        : unavailable.exec;
    const connectedAccounts =
        binding.availability.connectedAccounts === 'available'
        && binding.connectedAccountScopes !== undefined
        && params.connectedAccounts !== undefined
            ? params.connectedAccounts.bind(
                seed,
                binding.connectedAccountScopes,
                binding.exactPurposeBindingSubjectId
                    ? { exactPurposeBindingSubjectId: binding.exactPurposeBindingSubjectId }
                    : undefined,
            )
            : null;
    const interactions = createPluginInteractionsService({
        currentSession: seed.currentSession ?? null,
        signal: seed.signal,
        isGenerationCurrent: seed.isGenerationCurrent,
        ...(seed.readActiveTurnAdmissionWitness
            ? { readActiveTurnAdmissionWitness: seed.readActiveTurnAdmissionWitness }
            : {}),
        requester: Object.freeze({
            pluginId: seed.plugin.id,
            contributionId: seed.contribution.id,
            generationId: seed.generation,
            invocationId: seed.correlationId,
        }),
        permissionOwner: Object.freeze({
            kind: 'plugin',
            pluginId: seed.plugin.id,
            runtimeId: seed.contribution.qualifiedId,
        }),
        ...(params.approvals ? { approvals: params.approvals.bind(seed) } : {}),
    });
    const fileSystem = createAvailablePluginFileSystemService(seed, binding, params);
    const context: PluginInvocationServiceDescriptorContext = Object.freeze({
        seed,
        binding,
        params,
        exec,
        execAvailable,
        connectedAccounts,
        managedProviderRuntime,
        interactions,
        fileSystem,
    });
    const available = new Map<PluginServiceId, PluginServices[PluginServiceId]>();
    for (const serviceId of PLUGIN_SERVICE_IDS) {
        const service = PLUGIN_SERVICE_DESCRIPTORS[serviceId].createAvailable(context);
        if (service !== null) available.set(serviceId, service);
    }
    if (PLUGIN_SERVICE_IDS.some((serviceId) => {
        const descriptor = PLUGIN_SERVICE_DESCRIPTORS[serviceId];
        if (descriptor.availabilityOwner === 'host') return false;
        const boundAvailability = binding.availability[serviceId];
        return available.has(serviceId)
            ? boundAvailability !== 'available'
            : boundAvailability === 'available';
    })) {
        throw new Error('Plugin invocation service binding availability does not match the invocation services factory');
    }
    const services = Object.fromEntries(PLUGIN_SERVICE_IDS.map((serviceId) => {
        const descriptor = PLUGIN_SERVICE_DESCRIPTORS[serviceId];
        return [
            descriptor.publicProperty,
            available.get(serviceId) ?? unavailable[descriptor.publicProperty],
        ];
    })) as Omit<PluginServices, 'availability'>;
    return Object.freeze({
        availability: (serviceId: PluginServiceId) => {
            if (available.has(serviceId)) return Object.freeze({ status: 'available' as const });
            return binding.availability[serviceId] === 'denied'
                ? Object.freeze({ status: 'denied' as const, code: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE })
                : Object.freeze({
                    status: 'unavailable' as const,
                    code: binding.unavailableDiagnostics?.[serviceId]?.code
                        ?? PLUGIN_SERVICE_UNAVAILABLE_CODE,
                });
        },
        ...services,
    });
}
