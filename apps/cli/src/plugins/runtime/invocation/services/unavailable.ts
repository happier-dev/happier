import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    PluginConnectedAccountsService,
    PluginEventsService,
    PluginExecService,
    PluginFetchService,
    PluginFileSystemService,
    PluginLoggerService,
    PluginManagedService,
    PluginManagedDependenciesService,
    PluginMcpService,
    PluginNotificationsService,
    PluginResourcesService,
    PluginSecretsService,
    PluginServiceId,
    PluginServices,
    PluginSettingsService,
    PluginStorageScopeService,
    PluginStorageService,
} from '@happier-dev/plugin-sdk/runtime';
import type { HostExternalSessionsService } from '@/session/external/privateContract';
import type { ExecSystemToolServiceV1 } from '@/plugins/runtime/exec/privateContract';
import type { PluginStorePaths } from '@/plugins/store/paths';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { createStablePluginSecretsService } from '@/plugins/runtime/context/secrets';
import { createStablePluginStorageService } from '@/plugins/runtime/context/storage';

import { createPluginInvocationEventsService, type PluginInvocationEventsHost } from './events';
import { createStablePluginExecService } from './exec';
import { createPluginFileSystemService } from './filesystem';
import {
    createPluginInvocationLogger,
    type PluginInvocationLogSink,
    type PluginInvocationSecretRedactor,
} from './logger';
import type { StablePluginManagedServersHost } from './managed';
import type { StablePluginMcpHost } from './mcp';
import type { StablePluginNotificationsOwner } from './notifications';
import type { StablePluginResourcesOwner } from './resources';
import type { StablePluginSettingsHost } from './settings';
import type { StablePluginConnectedAccountsHost } from './connectedAccounts';
import type { StablePluginFetchHost } from '../../fetch/service';
import type {
    PluginFileSystemRoots,
    AuthorizePluginSecretAccess,
    PluginInvocationServiceBinding,
    PluginInvocationServicesSeed,
} from './types';

export const PLUGIN_SERVICE_UNAVAILABLE_CODE = 'plugin_service_unavailable';
export const PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE = 'plugin_host_access_resource_not_selected';

function unavailableMethod(
    serviceId: PluginServiceId,
    code: string = PLUGIN_SERVICE_UNAVAILABLE_CODE,
): () => never {
    return (): never => {
        throw new PluginError({
            code,
            message: code === PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE
                ? `Plugin service '${serviceId}' requires a selected host resource`
                : `Plugin service '${serviceId}' is unavailable in the current invocation host`,
            details: { serviceId },
        });
    };
}

function storageScope(code?: string): PluginStorageScopeService {
    const fail = unavailableMethod('storage', code);
    return Object.freeze({ get: fail, set: fail, delete: fail, consistency: fail, list: fail, transaction: fail });
}

export function createUnavailableHostExternalSessionsService(
    code?: string,
): HostExternalSessionsService {
    const fail = unavailableMethod('sessions', code);
    return Object.freeze({
        capabilities: fail,
        list: fail,
        attach: fail,
        takeover: fail,
        resolveFollowTarget: fail,
        readTranscript: fail,
        followTranscript: fail,
    });
}

type PluginServiceDescriptorMap = {
    readonly [ServiceId in PluginServiceId]: Readonly<{
        id: ServiceId;
        publicProperty: ServiceId;
        availabilityOwner: 'binding' | 'host';
        unavailableCode: typeof PLUGIN_SERVICE_UNAVAILABLE_CODE;
        deniedCode: typeof PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE;
        createUnavailable(code?: string): PluginServices[ServiceId];
        createAvailable(context: PluginInvocationServiceDescriptorContext): PluginServices[ServiceId] | null;
    }>;
};

export type PluginInvocationServicesFactoryParams = Readonly<{
    loggerSink: PluginInvocationLogSink;
    events: PluginInvocationEventsHost;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    filesystemRoots?: PluginFileSystemRoots;
    now?: () => number;
    exec?: Readonly<{
        resolveExecutable: (
            executable: Parameters<Parameters<typeof createStablePluginExecService>[0]['resolveExecutable']>[0],
            pluginId: string,
        ) => ReturnType<Parameters<typeof createStablePluginExecService>[0]['resolveExecutable']>;
        resolvePath: Parameters<typeof createStablePluginExecService>[0]['resolvePath'];
        environment?: Readonly<Record<string, string>>;
        agentCli?: Parameters<typeof createStablePluginExecService>[0]['agentCli'];
        systemTools?: ExecSystemToolServiceV1;
        systemToolsForPlugin?: (
            pluginId: string,
        ) => NonNullable<Parameters<typeof createStablePluginExecService>[0]['systemTools']>;
    }>;
    managed?: Readonly<{
        dependenciesForPlugin(pluginId: string): PluginManagedDependenciesService;
        serversHost: StablePluginManagedServersHost;
    }>;
    notifications?: StablePluginNotificationsOwner;
    mcp?: StablePluginMcpHost;
    resources?: StablePluginResourcesOwner;
    settings?: StablePluginSettingsHost;
    fetch?: StablePluginFetchHost;
    connectedAccounts?: StablePluginConnectedAccountsHost;
    storagePaths?: PluginStorePaths;
    authorizeSecretAccess?: AuthorizePluginSecretAccess;
    secretRedactor?: PluginInvocationSecretRedactor;
}>;

type PluginInvocationServiceDescriptorContext = Readonly<{
    seed: PluginInvocationServicesSeed;
    binding: PluginInvocationServiceBinding;
    params: PluginInvocationServicesFactoryParams;
    exec: PluginExecService;
    execAvailable: boolean;
}>;

/**
 * Canonical host-private roster for the public invocation service surface.
 * Public-property projection, concrete and unavailable implementations, and
 * truthful availability are derived from this table so a service cannot drift
 * between independently maintained matrices.
 */
export const PLUGIN_SERVICE_DESCRIPTORS = Object.freeze({
    logger: {
        id: 'logger', publicProperty: 'logger', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginLoggerService {
            const fail = unavailableMethod('logger', code);
            return Object.freeze({ debug: fail, info: fail, warn: fail, error: fail, diagnostic: fail });
        },
        createAvailable({ seed, params }): PluginLoggerService {
            return createPluginInvocationLogger({
                seed,
                sink: params.loggerSink,
                ...(params.secretRedactor ? { secretRedactor: params.secretRedactor } : {}),
                ...(params.now ? { now: params.now } : {}),
            });
        },
    },
    storage: {
        id: 'storage', publicProperty: 'storage', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginStorageService {
            return Object.freeze({ ephemeral: storageScope(code), session: storageScope(code), local: storageScope(code), synced: storageScope(code) });
        },
        createAvailable({ seed, binding, params }): PluginStorageService | null {
            if (binding.availability.storage === 'denied' || params.storagePaths === undefined) return null;
            return createStablePluginStorageService({
                pluginId: seed.plugin.id,
                paths: params.storagePaths,
                sessionId: seed.session?.id,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            });
        },
    },
    settings: {
        id: 'settings', publicProperty: 'settings', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginSettingsService {
            const fail = unavailableMethod('settings', code);
            return Object.freeze({ snapshot: fail, get: fail, set: fail, reset: fail, describe: fail, watch: fail });
        },
        createAvailable({ seed, binding, params }): PluginSettingsService | null {
            return binding.availability.settings !== 'denied'
                ? params.settings?.bind(seed) ?? null
                : null;
        },
    },
    secrets: {
        id: 'secrets', publicProperty: 'secrets', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginSecretsService {
            const fail = unavailableMethod('secrets', code);
            return Object.freeze({ status: fail, get: fail, set: fail, delete: fail });
        },
        createAvailable({ seed, binding, params }): PluginSecretsService | null {
            if (
                binding.availability.secrets !== 'available'
                || binding.secretScopes === undefined
                || params.storagePaths === undefined
                || params.authorizeSecretAccess === undefined
                || params.secretRedactor === undefined
            ) return null;
            return createStablePluginSecretsService({
                pluginId: seed.plugin.id,
                paths: params.storagePaths,
                declaredScopes: binding.secretScopes.map((scope) => Object.freeze({
                    secretIds: scope.secretIds,
                    access: scope.access,
                })),
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
                authorize: (check) => params.authorizeSecretAccess!({
                    pluginId: seed.plugin.id,
                    generation: seed.generation,
                    secretId: check.secretId,
                    access: check.access,
                    scopes: binding.secretScopes!,
                    ...(check.signal ? { signal: check.signal } : {}),
                }),
                registerForRedaction: (value) => params.secretRedactor!.register({
                    pluginId: seed.plugin.id,
                    generation: seed.generation,
                }, value),
            });
        },
    },
    events: {
        id: 'events', publicProperty: 'events', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginEventsService {
            const fail = unavailableMethod('events', code);
            return Object.freeze({ emit: fail, subscribe: fail });
        },
        createAvailable({ seed, params }): PluginEventsService {
            return createPluginInvocationEventsService({ seed, ...params.events });
        },
    },
    fetch: {
        id: 'fetch', publicProperty: 'fetch', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable: (code?: string): PluginFetchService => Object.freeze({ request: unavailableMethod('fetch', code) }),
        createAvailable({ seed, binding, params }): PluginFetchService | null {
            return binding.availability.fetch === 'available' && params.fetch !== undefined
                ? params.fetch.bind(seed, binding)
                : null;
        },
    },
    fs: {
        id: 'fs', publicProperty: 'fs', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginFileSystemService {
            const fail = unavailableMethod('fs', code);
            return Object.freeze({ readFile: fail, writeFile: fail, stat: fail, list: fail, remove: fail });
        },
        createAvailable({ seed, binding, params }): PluginFileSystemService | null {
            if (
                binding.availability.fs !== 'available'
                || binding.filesystemScopes === undefined
                || params.filesystemRoots === undefined
            ) return null;
            return createPluginFileSystemService({
                roots: params.filesystemRoots,
                scopes: binding.filesystemScopes,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            });
        },
    },
    exec: {
        id: 'exec', publicProperty: 'exec', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginExecService {
            const fail = unavailableMethod('exec', code);
            return Object.freeze({
                agentCli: Object.freeze({ checkReadiness: fail }),
                systemTools: Object.freeze({ resolve: fail }),
                run: fail,
                spawn: fail,
                clients: Object.freeze({ spawn: fail }),
            });
        },
        createAvailable({ binding, exec, execAvailable }): PluginExecService | null {
            return binding.availability.exec === 'available' && execAvailable ? exec : null;
        },
    },
    managed: {
        id: 'managed', publicProperty: 'managed', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginManagedService {
            const fail = unavailableMethod('managed', code);
            return Object.freeze({
                dependencies: Object.freeze({ status: fail, ensure: fail, update: fail, remove: fail }),
                servers: Object.freeze({ supervise: fail }),
            });
        },
        createAvailable({ seed, binding, params, exec, execAvailable }): PluginManagedService | null {
            if (
                binding.availability.managed !== 'available'
                || !execAvailable
                || params.managed === undefined
            ) return null;
            return Object.freeze({
                dependencies: params.managed.dependenciesForPlugin(seed.plugin.id),
                servers: params.managed.serversHost.bind({
                    generation: seed.generation,
                    pluginId: seed.plugin.id,
                    contributionId: seed.contribution.qualifiedId,
                    isGenerationCurrent: seed.isGenerationCurrent,
                    exec,
                }),
            });
        },
    },
    sessions: {
        id: 'sessions', publicProperty: 'sessions', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginServices['sessions'] {
            const fail = unavailableMethod('sessions', code);
            return Object.freeze({
                current: Object.freeze({
                    summary: fail, send: fail, watch: fail, availability: fail,
                    media: Object.freeze({ registerSourceRoot: fail }),
                }),
                list: fail, get: fail, watch: fail,
                subagents: Object.freeze({ capabilities: fail, list: fail, get: fail, observe: fail, watch: fail }),
            });
        },
        createAvailable: () => null,
    },
    resources: {
        id: 'resources', publicProperty: 'resources', availabilityOwner: 'host', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginResourcesService {
            const fail = unavailableMethod('resources', code);
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
                generation: seed.generation,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            });
        },
    },
    mcp: {
        id: 'mcp', publicProperty: 'mcp', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginMcpService {
            const fail = unavailableMethod('mcp', code);
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
        createUnavailable(code?: string): PluginNotificationsService {
            const fail = unavailableMethod('notifications', code);
            return Object.freeze({ send: fail, listChannels: fail, listCategories: fail, preferences: fail, watchPreferences: fail });
        },
        createAvailable({ seed, binding, params }): PluginNotificationsService | null {
            return binding.availability.notifications !== 'denied' && params.notifications !== undefined
                ? params.notifications.bind(seed)
                : null;
        },
    },
    connectedAccounts: {
        id: 'connectedAccounts', publicProperty: 'connectedAccounts', availabilityOwner: 'binding', unavailableCode: PLUGIN_SERVICE_UNAVAILABLE_CODE, deniedCode: PLUGIN_SERVICE_RESOURCE_NOT_SELECTED_CODE,
        createUnavailable(code?: string): PluginConnectedAccountsService {
            const fail = unavailableMethod('connectedAccounts', code);
            return Object.freeze({
                getBinding: fail,
                requestSelection: fail,
                materialize: fail,
                watch: fail,
            });
        },
        createAvailable({ seed, binding, params }): PluginConnectedAccountsService | null {
            return binding.availability.connectedAccounts === 'available'
                && binding.connectedAccountScopes !== undefined
                && params.connectedAccounts !== undefined
                ? params.connectedAccounts.bind(seed, binding.connectedAccountScopes)
                : null;
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

export function createUnavailablePluginServices(params?: Readonly<{
    deniedServiceIds?: readonly PluginServiceId[];
}>): PluginServices {
    const deniedServiceIds = new Set(params?.deniedServiceIds ?? []);
    const services = Object.fromEntries(PLUGIN_SERVICE_IDS.map((serviceId) => [
        PLUGIN_SERVICE_DESCRIPTORS[serviceId].publicProperty,
        PLUGIN_SERVICE_DESCRIPTORS[serviceId].createUnavailable(
            deniedServiceIds.has(serviceId) ? PLUGIN_SERVICE_DESCRIPTORS[serviceId].deniedCode : undefined,
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
                code: PLUGIN_SERVICE_UNAVAILABLE_CODE,
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
    });
    const execAvailable = binding.processExecutables !== undefined && params.exec !== undefined;
    const exec = execAvailable
        ? createStablePluginExecService({
            allowedExecutables: binding.processExecutables!,
            allowedEnvKeys: binding.processEnvKeys,
            allowedCwdScopes: binding.filesystemScopes,
            signal: seed.signal,
            isGenerationCurrent: seed.isGenerationCurrent,
            resolveExecutable: (executable) => params.exec!.resolveExecutable(executable, seed.plugin.id),
            resolvePath: params.exec!.resolvePath,
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
    const context: PluginInvocationServiceDescriptorContext = Object.freeze({
        seed,
        binding,
        params,
        exec,
        execAvailable,
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
                : Object.freeze({ status: 'unavailable' as const, code: PLUGIN_SERVICE_UNAVAILABLE_CODE });
        },
        ...services,
    });
}
