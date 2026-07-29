import {
    createPluginInvocationHostPolicyResolver,
    createTargetActionHostBindingResolver,
    createTargetActionHostPolicyResolver,
} from '../../hostAccess/resolve';
import {
    addConnectedAccountsAvailablePluginInvocationServiceBinding,
    addMcpAvailablePluginInvocationServiceBinding,
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createLoggerEventsAndExecServiceBinding,
    createLoggerFilesystemAndEventsServiceBinding,
    createLoggerFilesystemEventsAndExecServiceBinding,
    createPluginInvocationServicesFactory,
} from './factory';
import { withPluginInvocationServiceBindingAvailability } from './unavailable';
import {
    createPluginInvocationLogger,
    createPluginInvocationSecretRedactor,
    type PluginInvocationLogSink,
} from './logger';
import { createFilePluginInvocationLogSink } from './sink';
import type {
    AuthorizePluginSecretAccess,
    CreatePluginInvocationServiceBinding,
    PluginFileSystemRoots,
    PluginInvocationServiceBinding,
} from './types';
import { resolvePluginPathWithinRoots } from './filesystem';
import type { createStablePluginExecService } from './exec';
import type { PluginAgentCliReadinessService, PluginManagedDependenciesService } from '@happier-dev/plugin-sdk/runtime';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/runtime';
import type { ExecSystemToolServiceV1 } from '../../exec/privateContract';
import { createStablePluginManagedServersHost } from './managed';
import type { ManagedServerDurabilityOwner } from './managedServerDurability';
import {
    bindDeclaredEventSubscriptions,
    createStablePluginEventsBroker,
    type DeclaredEventSubscriptionRegistration,
    type PluginInvocationEventsHost,
} from './events';
import {
    createStablePluginNotificationsOwner,
    type StablePluginNotificationsHost,
} from './notifications';
import type { StablePluginMcpHost } from './mcp';
import type { StablePluginFetchHost } from '../../fetch/service';
import type { StablePluginResourcesOwner } from './resources';
import type { StablePluginManagedDependenciesHost } from './managedDependencies';
import type { PluginStorePaths } from '@/plugins/store/paths';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import type { ResolvedTargetAction } from '../actionExecutor';
import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';
import { createPluginStorageOwner } from '../../context/storage';
import {
    createAccountSettingsBackedSettingsRecordStore,
    createPluginStorageBackedSettingsRecordStore,
    createRoutedPluginSettingsRecordStore,
    createStablePluginSettingsHost,
} from './settings';
import {
    createActiveAccountSettingsPluginStorageScope,
    readActivePluginAccountSettings,
    updateActivePluginAccountSettings,
} from '../../context/accountSettingsStorage';
import { subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    createStablePluginConnectedAccountsHost,
    type StablePluginConnectedAccountsOwner,
} from './connectedAccounts';
import { findAvailableLoopbackPort } from '@/cloud/loopbackPort';
import type {
    HostRuntimeLimitMeasurementRecorder,
    HostRuntimeLimitMeasurementSample,
} from '@/agent/runtime/state/runtimeLimitMeasurement';

function readListenerFailureMessage(error: unknown): string {
    try {
        return error instanceof Error ? error.message : String(error);
    } catch {
        return '[unavailable listener error]';
    }
}

export function createProductionPluginInvocationServiceOwners(params?: Readonly<{
    loggerSink?: PluginInvocationLogSink;
    now?: () => number;
    filesystemRoots?: PluginFileSystemRoots;
    eventDeclarationsByPluginId?: PluginInvocationEventsHost['declarationsByPluginId'];
    permissionDeclarationsByPluginId?: PluginInvocationEventsHost['permissionDeclarationsByPluginId'];
    activePluginIds?: PluginInvocationEventsHost['activePluginIds'];
    exec?: Readonly<{
        agentCli?: PluginAgentCliReadinessService;
        systemToolsForPlugin?: (pluginId: string) => ExecSystemToolServiceV1;
        resolveExecutable: (
            executable: ManagedExecutableRef,
            pluginId: string,
        ) => ReturnType<Parameters<typeof createStablePluginExecService>[0]['resolveExecutable']>;
        resolvePath: Parameters<typeof createStablePluginExecService>[0]['resolvePath'];
    }>;
    managed?: Readonly<{
        dependencies?: PluginManagedDependenciesService;
        dependenciesHost?: Pick<StablePluginManagedDependenciesHost, 'bind'>
            & Partial<Pick<StablePluginManagedDependenciesHost, 'retireGeneration'>>;
        dependencyGeneration?: string;
        fetch?: typeof fetch;
        now?: () => number;
        createInstanceId?: () => string;
        selectPort?: (host: '127.0.0.1' | '::1') => number | Promise<number>;
        durability?: ManagedServerDurabilityOwner;
        captureProcessStartIdentity?: (pid: number) => Promise<string | null>;
    }>;
    notifications?: StablePluginNotificationsHost;
    mcp?: StablePluginMcpHost;
    fetch?: StablePluginFetchHost;
    resources?: StablePluginResourcesOwner;
    connectedAccounts?: StablePluginConnectedAccountsOwner;
    storagePaths?: PluginStorePaths;
    settingsDeclarations?: readonly Readonly<{
        pluginId: string;
        contribution: PluginSettingsContributionV2;
    }>[];
    authorizeSecretAccess?: AuthorizePluginSecretAccess;
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
    isGenerationCurrent?: (action: ResolvedTargetAction) => boolean | Promise<boolean>;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>) {
    const loggerSink = params?.loggerSink ?? createFilePluginInvocationLogSink();
    const secretRedactor = createPluginInvocationSecretRedactor();
    const listenerDiagnosticLoggers = new WeakMap<object, ReturnType<typeof createPluginInvocationLogger>>();
    const listenerDiagnosticSignal = new AbortController().signal;
    const recordRuntimeLimitMeasurement = params?.recordRuntimeLimitMeasurement
        ? (sample: HostRuntimeLimitMeasurementSample): void => {
            try {
                params.recordRuntimeLimitMeasurement?.(sample);
            } catch {
                // Measurement is observational and cannot alter invocation semantics.
            }
        }
        : undefined;
    const broker = createStablePluginEventsBroker({
        ...(recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement } : {}),
        onListenerError({ publication, subscriptionIdentity, error }) {
            let logger = listenerDiagnosticLoggers.get(subscriptionIdentity);
            if (!logger) {
                logger = createPluginInvocationLogger({
                    seed: {
                        plugin: {
                            id: subscriptionIdentity.pluginId,
                            version: subscriptionIdentity.pluginVersion,
                        },
                        contribution: {
                            id: subscriptionIdentity.contributionId,
                            qualifiedId: subscriptionIdentity.contributionQualifiedId,
                        },
                        generation: subscriptionIdentity.generation,
                        correlationId: subscriptionIdentity.correlationId,
                        surface: subscriptionIdentity.surface,
                        signal: listenerDiagnosticSignal,
                        isGenerationCurrent: () => true,
                    },
                    sink: loggerSink,
                    secretRedactor,
                    ...(params?.now ? { now: params.now } : {}),
                });
                listenerDiagnosticLoggers.set(subscriptionIdentity, logger);
            }
            logger.diagnostic({
                code: 'plugin_event_listener_failed',
                severity: 'error',
                message: 'Plugin event listener failed',
                details: {
                    event: {
                        pluginId: publication.event.ref.pluginId,
                        localId: publication.event.ref.localId,
                    },
                    publisher: {
                        pluginId: publication.identity.pluginId,
                        generation: publication.identity.generation,
                        correlationId: publication.identity.correlationId,
                    },
                    listenerError: readListenerFailureMessage(error),
                },
            });
        },
    });
    const events = Object.freeze({
        broker,
        declarationsByPluginId: params?.eventDeclarationsByPluginId ?? new Map(),
        permissionDeclarationsByPluginId: params?.permissionDeclarationsByPluginId ?? new Map(),
        activePluginIds: params?.activePluginIds ?? new Set<string>(),
    });
    const settingsHost = params?.storagePaths && params.settingsDeclarations
        ? createStablePluginSettingsHost({
            declarations: params.settingsDeclarations,
            recordStore: createRoutedPluginSettingsRecordStore([
                createPluginStorageBackedSettingsRecordStore({
                    storageForPlugin(pluginId) {
                        return createPluginStorageOwner({
                            pluginId,
                            paths: params.storagePaths!,
                        }).local;
                    },
                }),
                createAccountSettingsBackedSettingsRecordStore({
                    readSettings: readActivePluginAccountSettings,
                    isAvailable: () => readActivePluginAccountSettings() !== null,
                    subscribeSettings(listener) {
                        return subscribeActiveAccountSettingsSnapshot((previous, next) => {
                            listener(previous?.settings ?? null, next.settings);
                        });
                    },
                    updateSettings: updateActivePluginAccountSettings,
                }),
                createPluginStorageBackedSettingsRecordStore({
                    scope: 'synced',
                    isAvailable: () => readActivePluginAccountSettings() !== null,
                    storageForPlugin: createActiveAccountSettingsPluginStorageScope,
                }),
            ]),
            broker,
        })
        : null;
    const filesystemRoots = params?.filesystemRoots;
    const dependenciesForPlugin = params?.managed?.dependenciesHost
        ? (pluginId: string) => params.managed!.dependenciesHost!.bind(pluginId)
        : params?.managed?.dependencies
            ? () => params.managed!.dependencies!
            : null;
    const managedServersHost = params?.exec && params.managed && dependenciesForPlugin
        ? createStablePluginManagedServersHost({
            ...(params.managed.fetch ? { fetch: params.managed.fetch } : {}),
            ...(params.managed.now ? { now: params.managed.now } : {}),
            ...(params.managed.createInstanceId ? { createInstanceId: params.managed.createInstanceId } : {}),
            selectPort: params.managed.selectPort ?? findAvailableLoopbackPort,
            ...(params.managed.durability ? { durability: params.managed.durability } : {}),
            ...(params.managed.captureProcessStartIdentity
                ? { captureProcessStartIdentity: params.managed.captureProcessStartIdentity }
                : {}),
        })
        : null;
    const managedAvailable = managedServersHost !== null;
    const notificationsOwner = params?.notifications
        ? createStablePluginNotificationsOwner(params.notifications)
        : null;
    const connectedAccountsHost = params?.connectedAccounts
        ? createStablePluginConnectedAccountsHost(params.connectedAccounts, {
            registerForRedaction(seed, value) {
                secretRedactor.register({
                    pluginId: seed.plugin.id,
                    generation: seed.generation,
                }, value);
            },
        })
        : null;
    const createServicesFactory = createPluginInvocationServicesFactory({
        loggerSink,
        secretRedactor,
        events,
        ...(filesystemRoots ? { filesystemRoots } : {}),
        ...(params?.exec ? { exec: params.exec } : {}),
        ...(recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement } : {}),
        ...(managedServersHost && dependenciesForPlugin ? {
            managed: {
                dependenciesForPlugin,
                serversHost: managedServersHost,
            },
        } : {}),
        ...(notificationsOwner ? { notifications: notificationsOwner } : {}),
        ...(params?.mcp ? { mcp: params.mcp } : {}),
        ...(params?.fetch ? { fetch: params.fetch } : {}),
        ...(params?.resources ? { resources: params.resources } : {}),
        ...(connectedAccountsHost ? { connectedAccounts: connectedAccountsHost } : {}),
        ...(settingsHost ? { settings: settingsHost } : {}),
        ...(params?.authorizeSecretAccess ? { authorizeSecretAccess: params.authorizeSecretAccess } : {}),
        ...(params?.storagePaths ? { storagePaths: params.storagePaths } : {}),
        ...(params?.now ? { now: params.now } : {}),
    });
    const createOperationServicesFactory = (
        roots: PluginFileSystemRoots,
        environment: Readonly<Record<string, string>>,
        systemTools?: ExecSystemToolServiceV1,
    ) => createPluginInvocationServicesFactory({
        loggerSink,
        secretRedactor,
        events,
        filesystemRoots: roots,
        ...(params?.exec ? {
            exec: {
                ...(params.exec.agentCli ? { agentCli: params.exec.agentCli } : {}),
                ...(systemTools
                    ? { systemTools }
                    : params.exec.systemToolsForPlugin
                    ? { systemToolsForPlugin: params.exec.systemToolsForPlugin }
                    : {}),
                resolveExecutable: params.exec.resolveExecutable,
                resolvePath: async (path) => resolvePluginPathWithinRoots(roots, path),
                environment,
            },
        } : {}),
        ...(recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement } : {}),
        ...(managedServersHost && dependenciesForPlugin ? {
            managed: {
                dependenciesForPlugin,
                serversHost: managedServersHost,
            },
        } : {}),
        ...(notificationsOwner ? { notifications: notificationsOwner } : {}),
        ...(params?.mcp ? { mcp: params.mcp } : {}),
        ...(params?.fetch ? { fetch: params.fetch } : {}),
        ...(params?.resources ? { resources: params.resources } : {}),
        ...(connectedAccountsHost ? { connectedAccounts: connectedAccountsHost } : {}),
        ...(settingsHost ? { settings: settingsHost } : {}),
        ...(params?.authorizeSecretAccess ? { authorizeSecretAccess: params.authorizeSecretAccess } : {}),
        ...(params?.storagePaths ? { storagePaths: params.storagePaths } : {}),
        ...(params?.now ? { now: params.now } : {}),
    });
    const managedGenerationScopes = new Map<string, Readonly<{ generation: string; pluginId: string }>>();
    const invocationGenerationScopes = new Map<string, Readonly<{ generation: string; pluginId: string }>>();
    const resourceGenerations = new Set<string>();
    const managedGenerationKey = (generation: string, pluginId: string): string => `${generation}\u0000${pluginId}`;
    let disposePromise: Promise<void> | null = null;
    const addOrdinaryAvailableServices = (binding: PluginInvocationServiceBinding): PluginInvocationServiceBinding => {
        return params?.mcp
            ? addMcpAvailablePluginInvocationServiceBinding(binding)
            : binding;
    };
    const removeUnavailableSecrets = (
        binding: PluginInvocationServiceBinding,
    ): PluginInvocationServiceBinding => params?.storagePaths && params.authorizeSecretAccess
        ? binding
        : binding.availability.secrets === 'unavailable'
            ? binding
            : withPluginInvocationServiceBindingAvailability(
                binding,
                { serviceId: 'secrets', availability: 'unavailable' },
            );
    const removeUnavailableFetch = (
        binding: PluginInvocationServiceBinding,
    ): PluginInvocationServiceBinding => params?.fetch
        ? binding
        : binding.availability.fetch === 'unavailable'
            ? binding
            : withPluginInvocationServiceBindingAvailability(
                binding,
                { serviceId: 'fetch', availability: 'unavailable' },
            );
    const removeUnavailableHostBackedServices = (
        binding: PluginInvocationServiceBinding,
    ): PluginInvocationServiceBinding => removeUnavailableFetch(removeUnavailableSecrets(binding));
    const createOrdinaryServiceBinding = (
        generation: string,
        id: string,
        hostAccessRequests: readonly Readonly<{
            request: import('@happier-dev/protocol').PluginHostAccessRequestV2;
            required: boolean;
        }>[] = [],
    ): PluginInvocationServiceBinding => addOrdinaryAvailableServices(
        removeUnavailableHostBackedServices(createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            generation,
            id,
            hostAccessRequests,
        )),
    );
    const createTargetServiceBindingForRoots = (
        roots: PluginFileSystemRoots | undefined,
    ): CreatePluginInvocationServiceBinding => (
        generation,
        id,
        hostAccessRequests = [],
    ) => {
        const resolved = roots && params?.exec
            ? createLoggerFilesystemEventsAndExecServiceBinding(
                generation,
                id,
                hostAccessRequests,
                roots,
                managedAvailable,
            )
            : roots
                ? createLoggerFilesystemAndEventsServiceBinding(
                    generation,
                    id,
                    hostAccessRequests,
                    roots,
                )
                : params?.exec
                    ? createLoggerEventsAndExecServiceBinding(
                        generation,
                        id,
                        hostAccessRequests,
                        managedAvailable,
                    )
                    : createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                        generation,
                        id,
                        hostAccessRequests,
                    );
        const hostAvailable = connectedAccountsHost
            ? addConnectedAccountsAvailablePluginInvocationServiceBinding(resolved)
            : resolved;
        return addOrdinaryAvailableServices(removeUnavailableHostBackedServices(hostAvailable));
    };
    const createTargetServiceBinding = createTargetServiceBindingForRoots(filesystemRoots);
    const hostPolicyParams = {
        ...(params?.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
        createServiceBinding: createTargetServiceBinding,
    };
    const resolveHostPolicy = createTargetActionHostPolicyResolver(hostPolicyParams);
    const resolveInvocationHostPolicy = createPluginInvocationHostPolicyResolver(hostPolicyParams);
    const resolveBaseHostBinding = createTargetActionHostBindingResolver({
        ...hostPolicyParams,
        ...(params?.isGenerationCurrent ? { isGenerationCurrent: params.isGenerationCurrent } : {}),
    });
    return Object.freeze({
        bindDeclaredEventSubscriptions(params: Readonly<{
            registrations: readonly DeclaredEventSubscriptionRegistration[];
            isGenerationCurrent(registration: DeclaredEventSubscriptionRegistration): boolean;
            createContext(input: Readonly<{
                pluginId: string;
                pluginVersion: string;
                generation: string;
                localId: string;
                signal: AbortSignal;
            }>): import('@happier-dev/plugin-sdk').PluginInvocationContext;
        }>) {
            return bindDeclaredEventSubscriptions({ host: events, ...params });
        },
        async resolveHostBinding(...args: Parameters<typeof resolveBaseHostBinding>) {
            return await resolveBaseHostBinding(...args);
        },
        resolveHostPolicy,
        resolveInvocationHostPolicy,
        addOrdinaryAvailableServices,
        createOrdinaryServiceBinding,
        createOperationServices(
            seed: Parameters<typeof createServicesFactory>[0],
            operation: Readonly<{
                filesystemRoots: PluginFileSystemRoots;
                environment?: Readonly<Record<string, string>>;
                systemTools?: ExecSystemToolServiceV1;
                hostAccessRequests: readonly Readonly<{
                    request: import('@happier-dev/protocol').PluginHostAccessRequestV2;
                    required: boolean;
                }>[];
            }>,
        ): ReturnType<typeof createServicesFactory> {
            const binding = createPluginInvocationHostPolicyResolver({
                ...(params?.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
                createServiceBinding: createTargetServiceBindingForRoots(operation.filesystemRoots),
            })({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                qualifiedId: seed.contribution.qualifiedId,
            }, {
                hostAccessRequests: operation.hostAccessRequests,
                surface: seed.surface,
                signal: seed.signal,
            }).serviceBinding;
            if (managedServersHost) {
                managedGenerationScopes.set(
                    managedGenerationKey(seed.generation, seed.plugin.id),
                    Object.freeze({ generation: seed.generation, pluginId: seed.plugin.id }),
                );
            }
            if (params?.resources?.hasPlugin(seed.plugin.id)) resourceGenerations.add(seed.generation);
            invocationGenerationScopes.set(
                managedGenerationKey(seed.generation, seed.plugin.id),
                Object.freeze({ generation: seed.generation, pluginId: seed.plugin.id }),
            );
            return createOperationServicesFactory(
                operation.filesystemRoots,
                operation.environment ?? Object.freeze({}),
                operation.systemTools,
            )(seed, binding);
        },
        createServices(
            ...args: Parameters<typeof createServicesFactory>
        ): ReturnType<typeof createServicesFactory> {
            const [seed] = args;
            if (managedServersHost) {
                managedGenerationScopes.set(
                    managedGenerationKey(seed.generation, seed.plugin.id),
                    Object.freeze({ generation: seed.generation, pluginId: seed.plugin.id }),
                );
            }
            if (params?.resources?.hasPlugin(seed.plugin.id)) resourceGenerations.add(seed.generation);
            invocationGenerationScopes.set(
                managedGenerationKey(seed.generation, seed.plugin.id),
                Object.freeze({ generation: seed.generation, pluginId: seed.plugin.id }),
            );
            return createServicesFactory(seed, args[1]);
        },
        retireConnectedAccountConsumers(): void {
            connectedAccountsHost?.retire();
        },
        async retireGeneration(generation: string, pluginId: string): Promise<void> {
            try {
                await managedServersHost?.retireGeneration(generation, pluginId);
                params?.resources?.retireGeneration(generation);
            } finally {
                secretRedactor.retireGeneration(generation, pluginId);
                managedGenerationScopes.delete(managedGenerationKey(generation, pluginId));
                invocationGenerationScopes.delete(managedGenerationKey(generation, pluginId));
                resourceGenerations.delete(generation);
            }
        },
        dispose(): Promise<void> {
            disposePromise ??= (async () => {
                const scopes = [...managedGenerationScopes.values()];
                managedGenerationScopes.clear();
                const invocationScopes = [...invocationGenerationScopes.values()];
                invocationGenerationScopes.clear();
                for (const scope of invocationScopes) {
                    secretRedactor.retireGeneration(scope.generation, scope.pluginId);
                }
                const resources = [...resourceGenerations];
                resourceGenerations.clear();
                const results = await Promise.allSettled([
                    ...scopes.map((scope) => managedServersHost?.retireGeneration(scope.generation, scope.pluginId)),
                    ...(params?.mcp ? [params.mcp.dispose()] : []),
                    ...resources.map(async (generation) => params?.resources?.retireGeneration(generation)),
                ]);
                if (params?.managed?.dependenciesHost?.retireGeneration && params.managed.dependencyGeneration) {
                    try {
                        await params.managed.dependenciesHost.retireGeneration(params.managed.dependencyGeneration);
                    } catch (error) {
                        results.push({ status: 'rejected', reason: error });
                    }
                }
                const failures = results
                    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                    .map((result) => result.reason);
                if (failures.length > 0) {
                    throw new AggregateError(failures, 'Failed to dispose one or more plugin invocation service owners');
                }
            })();
            return disposePromise;
        },
    });
}
