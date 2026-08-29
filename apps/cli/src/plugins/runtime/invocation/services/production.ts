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
import {
    withPluginInvocationAccountStorageAvailability,
    withPluginInvocationServiceBindingAvailability,
} from './unavailable';
import {
    createPluginInvocationLogger,
    createPluginInvocationSecretRedactor,
    type PluginInvocationLogSink,
} from './logger';
import { createFilePluginInvocationLogSink } from './sink';
import type {
    CreatePluginInvocationServiceBinding,
    PluginFileSystemRoots,
    PluginInvocationServiceBinding,
    PluginInvocationServicesSeed,
    PluginProviderOperationsSource,
} from './types';
import { resolvePluginPathWithinRoots } from './filesystem';
import type { createStablePluginExecService } from './exec';
import type {
    InteractionsService } from '@happier-dev/plugin-sdk/interactions';
import type {
    ManagedExecutableRef,
    ManagedServiceHandle } from '@happier-dev/plugin-sdk/managed-services';
import type {
    AgentCliReadinessService as PluginAgentCliReadinessService } from '@happier-dev/plugin-sdk/exec';
import type {
    PluginServices,
} from '@happier-dev/plugin-sdk';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { ExecSystemToolServiceV1 } from '../../exec/privateContract';
import {
    bindDeclaredEventSubscriptions,
    createStablePluginEventsBroker,
    type DeclaredEventSubscriptionRegistration,
    type PluginInvocationEventsHost,
    type StablePluginEventsBroker,
} from './events';
import {
    createStablePluginNotificationsOwner,
    type NotificationCategoryDeclaration,
    type StablePluginNotificationsHost,
} from './notifications';
import type { StablePluginMcpHost } from './mcp';
import type {
    StablePluginHttpBindingPolicy,
    StablePluginHttpHost,
} from '../../fetch/service';
import type { StablePluginResourcesOwner } from './resources';
import type { PluginStorePaths } from '@/plugins/store/paths';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import type { ResolvedTargetAction } from '../actionExecutor';
import type {
    PluginMachineMaterializationRefV1,
    PluginSettingsContributionV2,
} from '@happier-dev/protocol';
import { join } from 'node:path';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import {
    createPluginStorageOwner,
    type StablePluginAccountStorageHost,
} from '../../context/storage';
import type { StablePluginDaemonDatabaseHost } from '../../context/daemonDatabase';
import { createAccountPluginSecretCustodyRouter } from '../../context/accountPluginSecretCustody';
import {
    createDaemonPluginSecretCustodyRouter,
    createPluginSecretCustodyRouter,
    createStableDeclaredPluginSecretsHost,
} from '../../context/secrets';
import type { PluginSecretDeclaration } from '../../context/declaredPluginSecrets';
import {
    createAccountSettingsBackedSettingsRecordStore,
    createPluginStorageBackedSettingsRecordStore,
    createRoutedPluginSettingsRecordStore,
    createStablePluginSettingsHost,
    type PluginAccountSettingsRecordAdapter,
    type PluginSettingsRollbackDeclarations,
} from './settings';
import { createAccountPluginSettingsRecordStorage } from '../../context/accountPluginSettingsRecordStorage';
import {
    createStablePluginConnectedAccountsHost,
    type StablePluginConnectedAccountsOwner,
} from './connectedAccounts';
import type {
    ManagedProviderEndpointAccessProjection,
    ManagedProviderEndpointPath,
    ManagedProviderRuntimeOperationBinding,
    ManagedServiceCredentialFileOwner,
    ManagedServicesInvocationOwner,
} from './managedServicesAdapter';
import type {
    HostRuntimeLimitMeasurementRecorder,
    HostRuntimeLimitMeasurementSample,
} from '@/agent/runtime/state/runtimeLimitMeasurement';
import { createProductionPluginApprovalQueueOwner } from './approvalQueueProduction';
import type {
    InvokeContributedAction,
    PluginActionsHostExecutor,
} from './actions';
import type { StableTargetedContributionsOwner } from './targetedContributions';
import type { StablePluginComposerContentOwner } from './composerContent';

type ResolvePluginExecutable = (
    executable: ManagedExecutableRef,
    pluginId: string,
    context?: unknown,
) => ReturnType<
    Parameters<typeof createStablePluginExecService>[0][
        'resolveExecutable'
    ]
>;

export type { PluginSecretDeclaration } from '../../context/declaredPluginSecrets';

type PluginOperationServicesInput = Readonly<{
    filesystemRoots: PluginFileSystemRoots;
    environment?: Readonly<Record<string, string>>;
    systemTools?: ExecSystemToolServiceV1;
    settingsDeclarations?: readonly Readonly<{
        pluginId: string;
        contribution: PluginSettingsContributionV2;
    }>[];
    /** Testable port for the one reserved Account Settings record owner. */
    accountSettingsRecordAdapter?: PluginAccountSettingsRecordAdapter;
    secretDeclarations?: readonly PluginSecretDeclaration[];
    eventDeclarationsByPluginId?:
        PluginInvocationEventsHost['declarationsByPluginId'];
    activePluginIds?: PluginInvocationEventsHost['activePluginIds'];
    resources?: StablePluginResourcesOwner | null;
    httpBinding?: StablePluginHttpBindingPolicy;
    notificationCategories?: readonly NotificationCategoryDeclaration[];
    managedProviderRuntime?: ManagedProviderRuntimeOperationBinding;
    exactPurposeBindingSubjectId?: string;
    resolveExecutable?: ResolvePluginExecutable;
    hostAccessRequests: readonly Readonly<{
        request: import('@happier-dev/protocol').PluginHostAccessRequestV2;
        required: boolean;
    }>[];
    /** The isolated Agent/session process has no duplex WebSocket wire. */
    executionRealm?: 'runner';
}>;

export type ManagedProviderRuntimeInvocationServices = Readonly<{
    connectedAccounts: PluginServices['connectedAccounts'];
    managedServices: PluginServices['managedServices'];
    projectEndpointAccess(input: Readonly<{
        service: ManagedServiceHandle;
        endpoints: readonly ManagedProviderEndpointPath[];
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): Promise<ManagedProviderEndpointAccessProjection | null>;
}>;

type PluginInvocationRawRedactionScope = Readonly<{
    plugin: Readonly<{ id: string }>;
    generation: string;
    correlationId: string;
}>;

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
    resolveFilesystemRoots?: (pluginId: string) => PluginFileSystemRoots | null;
    eventDeclarationsByPluginId?: PluginInvocationEventsHost['declarationsByPluginId'];
    activePluginIds?: PluginInvocationEventsHost['activePluginIds'];
    eventsBroker?: StablePluginEventsBroker;
    exec?: Readonly<{
        agentCli?: PluginAgentCliReadinessService;
        systemToolsForPlugin?: (pluginId: string) => ExecSystemToolServiceV1;
        resolveExecutable: ResolvePluginExecutable;
        resolvePath: Parameters<typeof createStablePluginExecService>[0]['resolvePath'];
    }>;
    managedServices?: ManagedServicesInvocationOwner;
    providers?: PluginProviderOperationsSource;
    managedServiceCredentialFiles?: ManagedServiceCredentialFileOwner;
    notifications?: StablePluginNotificationsHost;
    mcp?: StablePluginMcpHost;
    sessions?: Readonly<{
        bind(
            seed: PluginInvocationServicesSeed,
            binding: PluginInvocationServiceBinding,
            interactions: InteractionsService,
            filesystemRoots?: PluginFileSystemRoots,
        ): PluginServices['sessions'];
    }>;
    http?: StablePluginHttpHost;
    resources?: StablePluginResourcesOwner;
    connectedAccounts?: StablePluginConnectedAccountsOwner;
    storagePaths?: PluginStorePaths;
    /** Generation-owned daemon database host; absence remains fail-closed. */
    daemonDatabase?: StablePluginDaemonDatabaseHost;
    /** Canonical Account Data host; absence remains a typed unavailable leaf. */
    accountStorage?: StablePluginAccountStorageHost;
    settingsDeclarations?: readonly Readonly<{
        pluginId: string;
        contribution: PluginSettingsContributionV2;
    }>[];
    /**
     * The one supported rollback Settings declaration per (pluginId, scope),
     * derived once per registry generation from the existing generation
     * support state. Absent means the support state was not readable, so the
     * Settings owner preserves every removed value instead of pruning.
     */
    settingsRollbackDeclarations?: PluginSettingsRollbackDeclarations;
    /**
     * Reports a plugin whose declared settings could not be modelled. The
     * declaration set spans every plugin, so the host isolates the offender and
     * this is the only channel that makes its loss visible.
     */
    onPluginSettingsUnavailable?(input: Readonly<{ pluginId: string; error: unknown }>): void;
    /** Testable port for the one reserved Account Settings record owner. */
    accountSettingsRecordAdapter?: PluginAccountSettingsRecordAdapter;
    secretDeclarations?: readonly PluginSecretDeclaration[];
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
    isGenerationCurrent?: (action: ResolvedTargetAction) => boolean | Promise<boolean>;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    actionExecutor?: PluginActionsHostExecutor;
    invokeContributedAction?: InvokeContributedAction;
    targetedContributions?: StableTargetedContributionsOwner;
    composerContent?: StablePluginComposerContentOwner;
    /**
     * Host-private current materialization authority. The resolved runtime
     * registry owns this lookup; invocation service construction only consumes
     * its result to stamp the immediate plugin caller for nested Actions.
     */
    resolveCurrentPluginMaterializationRef?(
        pluginId: string,
    ): PluginMachineMaterializationRefV1 | null;
}>) {
    const attachCurrentPluginMaterializationResolver = (
        seed: PluginInvocationServicesSeed,
    ): PluginInvocationServicesSeed => {
        if (
            seed.resolveCurrentPluginMaterializationRef
            || !params?.resolveCurrentPluginMaterializationRef
        ) return seed;
        const pluginId = seed.plugin.id;
        return Object.freeze({
            ...seed,
            resolveCurrentPluginMaterializationRef: () => (
                params.resolveCurrentPluginMaterializationRef!(pluginId)
            ),
        });
    };
    const loggerSink = params?.loggerSink ?? createFilePluginInvocationLogSink();
    const secretRedactor = createPluginInvocationSecretRedactor();
    const listenerDiagnosticLoggers = new WeakMap<object, ReturnType<typeof createPluginInvocationLogger>>();
    const invocationLoggers = new WeakMap<object, ReturnType<typeof createPluginInvocationLogger>>();
    const listenerDiagnosticSignal = new AbortController().signal;
    const resolveInvocationLogger = (
        seed: PluginInvocationServicesSeed,
    ): ReturnType<typeof createPluginInvocationLogger> => {
        let invocationLogger = invocationLoggers.get(seed);
        if (!invocationLogger) {
            invocationLogger = createPluginInvocationLogger({
                seed,
                sink: loggerSink,
                secretRedactor,
                ...(params?.now ? { now: params.now } : {}),
            });
            invocationLoggers.set(seed, invocationLogger);
        }
        return invocationLogger;
    };
    const approvals = createProductionPluginApprovalQueueOwner({
        recordDiagnostic(seed, error) {
            resolveInvocationLogger(seed).diagnostic({
                code: 'plugin_approval_queue_listener_failed',
                severity: 'error',
                message: readListenerFailureMessage(error),
            });
        },
    });
    const recordRuntimeLimitMeasurement = params?.recordRuntimeLimitMeasurement
        ? (sample: HostRuntimeLimitMeasurementSample): void => {
            try {
                params.recordRuntimeLimitMeasurement?.(sample);
            } catch {
                // Measurement is observational and cannot alter invocation semantics.
            }
        }
        : undefined;
    const broker = params?.eventsBroker ?? createStablePluginEventsBroker({
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
        activePluginIds: params?.activePluginIds ?? new Set<string>(),
    });
    const accountSettingsRecordAdapter = params?.accountSettingsRecordAdapter
        ?? createAccountPluginSettingsRecordStorage();
    const storagePaths = params?.storagePaths;
    const createSettingsHost = (
        declarations: readonly Readonly<{
            pluginId: string;
            contribution: PluginSettingsContributionV2;
        }>[],
    ) => createStablePluginSettingsHost({
            declarations,
            ...(params?.onPluginSettingsUnavailable
                ? { onPluginSettingsUnavailable: params.onPluginSettingsUnavailable }
                : {}),
            ...(params?.settingsRollbackDeclarations
                ? { rollbackDeclarations: params.settingsRollbackDeclarations }
                : {}),
            recordStore: createRoutedPluginSettingsRecordStore([
                ...(storagePaths
                    ? [createPluginStorageBackedSettingsRecordStore({
                        storageForPlugin(pluginId) {
                            return createPluginStorageOwner({
                                pluginId,
                                paths: storagePaths,
                            }).daemon;
                        },
                    })]
                    : []),
                createAccountSettingsBackedSettingsRecordStore(accountSettingsRecordAdapter),
            ]),
            broker,
        });
    const settingsHost = params?.settingsDeclarations
        ? createSettingsHost(params.settingsDeclarations)
        : null;
    const accountSecretCustody = createAccountPluginSecretCustodyRouter();
    const daemonSecretCustody = storagePaths
        ? createDaemonPluginSecretCustodyRouter({
            paths: storagePaths,
            resolveDeviceLocalSecretStorage: async () => await readOrCreateDeviceLocalSecretStorage({
                path: join(storagePaths.happyHomeDir, 'device-local-secret-key.json'),
            }),
        })
        : null;
    const secretCustody = createPluginSecretCustodyRouter({
        account: accountSecretCustody.resolve,
        ...(daemonSecretCustody ? { daemon: daemonSecretCustody.resolve } : {}),
    });
    const createSecretsHost = (declarations: readonly PluginSecretDeclaration[]) => (
        declarations.length > 0
            ? createStableDeclaredPluginSecretsHost({
                declarations,
                resolveCustody: secretCustody.resolve,
            })
            : null
    );
    const secretsHost = params?.secretDeclarations
        ? createSecretsHost(params.secretDeclarations)
        : null;
    const filesystemRoots = params?.filesystemRoots;
    const notificationsOwner = params?.notifications
        ? createStablePluginNotificationsOwner(params.notifications)
        : null;
    const connectedAccountsHost = params?.connectedAccounts
        ? createStablePluginConnectedAccountsHost(params.connectedAccounts, {
            registerRawForRedaction(seed, value) {
                secretRedactor.registerRaw({
                    pluginId: seed.plugin.id,
                    generation: seed.generation,
                    correlationId: seed.correlationId,
                }, value);
            },
            registerExactForRedaction(seed, value) {
                secretRedactor.registerExact({
                    pluginId: seed.plugin.id,
                    generation: seed.generation,
                    correlationId: seed.correlationId,
                }, value);
            },
        })
        : null;
    const createServicesFactory = createPluginInvocationServicesFactory({
        loggerSink,
        resolveLogger: resolveInvocationLogger,
        secretRedactor,
        events,
        approvals,
        ...(params?.actionExecutor ? { actionExecutor: params.actionExecutor } : {}),
        ...(params?.invokeContributedAction ? { invokeContributedAction: params.invokeContributedAction } : {}),
        ...(params?.targetedContributions ? { targetedContributions: params.targetedContributions } : {}),
        ...(params?.composerContent ? { composerContent: params.composerContent } : {}),
        ...(filesystemRoots ? { filesystemRoots } : {}),
        ...(params?.resolveFilesystemRoots
            ? {
                resolveFilesystemRoots: (seed: PluginInvocationServicesSeed) => (
                    params.resolveFilesystemRoots?.(seed.plugin.id) ?? null
                ),
            }
            : {}),
        ...(params?.exec ? { exec: params.exec } : {}),
        ...(recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement } : {}),
        ...(params?.managedServices ? { managedServices: params.managedServices } : {}),
        ...(params?.providers ? { providers: params.providers } : {}),
        ...(params?.managedServiceCredentialFiles
            ? {
                managedServiceCredentialFiles:
                    params.managedServiceCredentialFiles,
            }
            : {}),
        ...(notificationsOwner ? { notifications: notificationsOwner } : {}),
        ...(params?.mcp ? { mcp: params.mcp } : {}),
        ...(params?.sessions ? { sessions: params.sessions } : {}),
        ...(params?.http ? { http: params.http } : {}),
        ...(params?.resources ? { resources: params.resources } : {}),
        ...(connectedAccountsHost ? { connectedAccounts: connectedAccountsHost } : {}),
        ...(settingsHost ? { settings: settingsHost } : {}),
        ...(secretsHost ? { secrets: secretsHost } : {}),
        ...(params?.storagePaths ? { storagePaths: params.storagePaths } : {}),
        ...(params?.daemonDatabase ? { daemonDatabase: params.daemonDatabase } : {}),
        ...(params?.accountStorage ? { accountStorage: params.accountStorage } : {}),
        ...(params?.now ? { now: params.now } : {}),
    });
    const createOperationServicesFactory = (
        roots: PluginFileSystemRoots,
        environment: Readonly<Record<string, string>>,
        systemTools?: ExecSystemToolServiceV1,
        overrides?: Readonly<{
            settingsDeclarations?: readonly Readonly<{
                pluginId: string;
                contribution: PluginSettingsContributionV2;
            }>[];
            secretDeclarations?: readonly PluginSecretDeclaration[];
            eventDeclarationsByPluginId?:
                PluginInvocationEventsHost['declarationsByPluginId'];
            activePluginIds?:
                PluginInvocationEventsHost['activePluginIds'];
            resources?: StablePluginResourcesOwner | null;
            httpBinding?: StablePluginHttpBindingPolicy;
            notificationCategories?:
                readonly NotificationCategoryDeclaration[];
            managedProviderRuntime?:
                ManagedProviderRuntimeOperationBinding;
            exactPurposeBindingSubjectId?: string;
            resolveExecutable?: ResolvePluginExecutable;
        }>,
    ) => {
        const operationEvents =
            overrides?.eventDeclarationsByPluginId
            || overrides?.activePluginIds
                ? Object.freeze({
                    ...events,
                    declarationsByPluginId:
                        overrides?.eventDeclarationsByPluginId
                        ?? events.declarationsByPluginId,
                    activePluginIds:
                        overrides?.activePluginIds
                        ?? events.activePluginIds,
                })
                : events;
        const operationSettingsHost =
            overrides?.settingsDeclarations !== undefined
                ? createSettingsHost(
                    overrides.settingsDeclarations,
                )
                : settingsHost;
        const operationSecretsHost =
            overrides?.secretDeclarations !== undefined
                ? createSecretsHost(overrides.secretDeclarations)
                : secretsHost;
        const operationManagedServiceDeclaredSecretReadPort =
            operationSecretsHost
                ? Object.freeze({
                    bind(seed: PluginInvocationServicesSeed) {
                        return operationSecretsHost
                            .bindManagedServiceSecretReadPort({
                                pluginId: seed.plugin.id,
                                signal: seed.signal,
                                isGenerationCurrent:
                                    seed.isGenerationCurrent,
                                registerRawForRedaction(value) {
                                    secretRedactor.registerRaw({
                                        pluginId: seed.plugin.id,
                                        generation: seed.generation,
                                        correlationId: seed.correlationId,
                                    }, value);
                                },
                            });
                    },
                })
                : null;
        const operationResources =
            overrides?.resources === undefined
                ? params?.resources
                : overrides.resources ?? undefined;
        const operationHttpBinding =
            overrides?.httpBinding;
        const operationHttp =
            operationHttpBinding && params?.http
                ? Object.freeze({
                    bind(
                        seed: PluginInvocationServicesSeed,
                        binding: PluginInvocationServiceBinding,
                    ) {
                        return params.http!.bind(
                            seed,
                            binding,
                            operationHttpBinding,
                        );
                    },
                })
                : params?.http;
        const operationNotificationCategories =
            overrides?.notificationCategories;
        const operationNotificationsOwner =
            operationNotificationCategories !== undefined
            && notificationsOwner
                ? Object.freeze({
                    bind(seed: PluginInvocationServicesSeed) {
                        return notificationsOwner.bind(seed, {
                            categories:
                                operationNotificationCategories,
                        });
                    },
                })
                : notificationsOwner;
        const operationConnectedAccountsHost =
            overrides?.exactPurposeBindingSubjectId
            && connectedAccountsHost
                ? Object.freeze({
                    bind(
                        seed: PluginInvocationServicesSeed,
                        scopes: Parameters<
                            typeof connectedAccountsHost.bind
                        >[1],
                    ) {
                        return connectedAccountsHost.bind(seed, scopes, {
                            exactPurposeBindingSubjectId:
                                overrides.exactPurposeBindingSubjectId,
                        });
                    },
                    retire: connectedAccountsHost.retire,
                })
                : connectedAccountsHost;
        return createPluginInvocationServicesFactory({
            loggerSink,
            resolveLogger: resolveInvocationLogger,
            secretRedactor,
            events: operationEvents,
            approvals,
            ...(params?.actionExecutor ? { actionExecutor: params.actionExecutor } : {}),
            ...(params?.invokeContributedAction ? { invokeContributedAction: params.invokeContributedAction } : {}),
            ...(params?.targetedContributions ? { targetedContributions: params.targetedContributions } : {}),
            ...(params?.composerContent ? { composerContent: params.composerContent } : {}),
            filesystemRoots: roots,
            ...(params?.exec ? {
                exec: {
                    ...(params.exec.agentCli ? { agentCli: params.exec.agentCli } : {}),
                    ...(systemTools
                        ? { systemTools }
                        : params.exec.systemToolsForPlugin
                        ? { systemToolsForPlugin: params.exec.systemToolsForPlugin }
                        : {}),
                    resolveExecutable:
                        overrides?.resolveExecutable
                        ?? params.exec.resolveExecutable,
                    resolvePath: async (path) => resolvePluginPathWithinRoots(roots, path),
                    environment,
                },
            } : {}),
            ...(recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement } : {}),
            ...(params?.managedServices ? { managedServices: params.managedServices } : {}),
            ...(operationManagedServiceDeclaredSecretReadPort
                ? {
                    managedServiceDeclaredSecretReadPort:
                        operationManagedServiceDeclaredSecretReadPort,
                }
                : {}),
            ...(params?.providers ? { providers: params.providers } : {}),
            ...(overrides?.managedProviderRuntime
                ? {
                    managedProviderRuntime:
                        overrides.managedProviderRuntime,
                }
                : {}),
            ...(params?.managedServiceCredentialFiles
                ? {
                    managedServiceCredentialFiles:
                        params.managedServiceCredentialFiles,
                }
                : {}),
            ...(operationNotificationsOwner
                ? { notifications: operationNotificationsOwner }
                : {}),
            ...(params?.mcp ? { mcp: params.mcp } : {}),
            ...(params?.sessions ? { sessions: params.sessions } : {}),
            ...(operationHttp ? { http: operationHttp } : {}),
            ...(operationResources
                ? { resources: operationResources }
                : {}),
            ...(operationConnectedAccountsHost
                ? { connectedAccounts: operationConnectedAccountsHost }
                : {}),
            ...(operationSettingsHost
                ? { settings: operationSettingsHost }
                : {}),
            ...(operationSecretsHost
                ? { secrets: operationSecretsHost }
                : {}),
            ...(params?.storagePaths ? { storagePaths: params.storagePaths } : {}),
            ...(params?.daemonDatabase ? { daemonDatabase: params.daemonDatabase } : {}),
            ...(params?.accountStorage ? { accountStorage: params.accountStorage } : {}),
            ...(params?.now ? { now: params.now } : {}),
        });
    };
    const invocationGenerationScopes = new Map<string, Readonly<{ generation: string; pluginId: string }>>();
    const managedGenerationKey = (generation: string, pluginId: string): string => `${generation}\u0000${pluginId}`;
    const resourceOwnersByGenerationKey = new Map<string, Readonly<{
        generation: string;
        pluginId: string;
        owners: Set<StablePluginResourcesOwner>;
    }>>();
    const retainResourceGeneration = (
        owner: StablePluginResourcesOwner | null | undefined,
        generation: string,
        pluginId: string,
    ): void => {
        if (!owner?.hasPlugin(pluginId)) return;
        const key = managedGenerationKey(generation, pluginId);
        const retained = resourceOwnersByGenerationKey.get(key)
            ?? Object.freeze({
                generation,
                pluginId,
                owners: new Set<StablePluginResourcesOwner>(),
            });
        retained.owners.add(owner);
        resourceOwnersByGenerationKey.set(key, retained);
    };
    let disposePromise: Promise<void> | null = null;
    const addOrdinaryAvailableServices = (binding: PluginInvocationServiceBinding): PluginInvocationServiceBinding => {
        return params?.mcp
            ? addMcpAvailablePluginInvocationServiceBinding(binding)
            : binding;
    };
    const removeUnavailableHttp = (
        binding: PluginInvocationServiceBinding,
    ): PluginInvocationServiceBinding => params?.http
        ? binding.availability.http === 'available'
            ? binding
            : Object.freeze({
                ...withPluginInvocationServiceBindingAvailability(
                    binding,
                    { serviceId: 'http', availability: 'available' },
                ),
                networkOrigins: binding.networkOrigins ?? Object.freeze([]),
                networkScopes: binding.networkScopes ?? Object.freeze([]),
            })
        : binding.availability.http === 'unavailable'
            ? binding
            : withPluginInvocationServiceBindingAvailability(
                binding,
                { serviceId: 'http', availability: 'unavailable' },
            );
    const removeUnavailableHostBackedServices = (
        binding: PluginInvocationServiceBinding,
    ): PluginInvocationServiceBinding => removeUnavailableHttp(binding);
    const addManagedServicesAvailability = (
        generation: string,
        contributionQualifiedId: string,
        binding: PluginInvocationServiceBinding,
    ): PluginInvocationServiceBinding => params?.managedServices?.isAvailable({
        generation,
        contributionQualifiedId,
    }) === true
        ? withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'managedServices', availability: 'available' },
        )
        : binding;
    const createOrdinaryServiceBinding = (
        generation: string,
        id: string,
        hostAccessRequests: readonly Readonly<{
            request: import('@happier-dev/protocol').PluginHostAccessRequestV2;
            required: boolean;
        }>[] = [],
        contributionQualifiedId = id,
    ): PluginInvocationServiceBinding => addManagedServicesAvailability(
        generation,
        contributionQualifiedId,
        addOrdinaryAvailableServices(
            removeUnavailableHostBackedServices(createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                generation,
                id,
                hostAccessRequests,
            )),
        ),
    );
    const createTargetServiceBindingForRoots = (
        roots: PluginFileSystemRoots | undefined,
    ): CreatePluginInvocationServiceBinding => (
        generation,
        id,
        hostAccessRequests = [],
        contributionQualifiedId = id,
    ) => {
        const processDeclarationsAvailable = params?.exec !== undefined;
        const resolved = roots && processDeclarationsAvailable
            ? createLoggerFilesystemEventsAndExecServiceBinding(
                generation,
                id,
                hostAccessRequests,
                roots,
                false,
                params?.exec !== undefined,
            )
            : roots
                ? createLoggerFilesystemAndEventsServiceBinding(
                    generation,
                    id,
                    hostAccessRequests,
                    roots,
                )
                : processDeclarationsAvailable
                    ? createLoggerEventsAndExecServiceBinding(
                        generation,
                        id,
                        hostAccessRequests,
                        false,
                        params?.exec !== undefined,
                    )
                    : createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                        generation,
                        id,
                        hostAccessRequests,
                    );
        const publicFilesystemBinding = addManagedServicesAvailability(
            generation,
            contributionQualifiedId,
            resolved,
        );
        const hostAvailable = connectedAccountsHost
            ? addConnectedAccountsAvailablePluginInvocationServiceBinding(
                publicFilesystemBinding,
            )
            : publicFilesystemBinding;
        const accountStorageAvailable = params?.accountStorage !== undefined && params.storagePaths !== undefined
            ? withPluginInvocationAccountStorageAvailability(hostAvailable, 'available')
            : hostAvailable;
        return addOrdinaryAvailableServices(removeUnavailableHostBackedServices(accountStorageAvailable));
    };
    const createTargetServiceBinding: CreatePluginInvocationServiceBinding = (
        generation,
        id,
        hostAccessRequests = [],
        contributionQualifiedId = id,
    ) => {
        const pluginId = contributionQualifiedId.split('/', 1)[0] ?? '';
        const roots = filesystemRoots
            ?? params?.resolveFilesystemRoots?.(pluginId)
            ?? undefined;
        return createTargetServiceBindingForRoots(roots)(
            generation,
            id,
            hostAccessRequests,
            contributionQualifiedId,
        );
    };
    const hostPolicyParams = {
        ...(params?.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
        createServiceBinding: createTargetServiceBinding,
        sessionServiceAvailable: params?.sessions !== undefined,
    };
    const resolveHostPolicy = createTargetActionHostPolicyResolver(hostPolicyParams);
    const resolveInvocationHostPolicy = createPluginInvocationHostPolicyResolver(hostPolicyParams);
    const resolveBaseHostBinding = createTargetActionHostBindingResolver({
        ...hostPolicyParams,
        ...(params?.isGenerationCurrent ? { isGenerationCurrent: params.isGenerationCurrent } : {}),
    });
    const createOperationServices = (
        seed: Parameters<typeof createServicesFactory>[0],
        operation: PluginOperationServicesInput,
    ): ReturnType<typeof createServicesFactory> => {
        const currentSeed = attachCurrentPluginMaterializationResolver(seed);
        const baseBinding = createPluginInvocationHostPolicyResolver({
            ...(params?.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
            createServiceBinding: createTargetServiceBindingForRoots(operation.filesystemRoots),
            sessionServiceAvailable: params?.sessions !== undefined,
        })({
            pluginId: currentSeed.plugin.id,
            generation: currentSeed.generation,
            qualifiedId: currentSeed.contribution.qualifiedId,
        }, {
            hostAccessRequests: operation.hostAccessRequests,
            surface: currentSeed.surface,
            signal: currentSeed.signal,
            ...(operation.executionRealm === undefined
                ? {}
                : { executionRealm: operation.executionRealm }),
        }).serviceBinding;
        const binding = operation.managedProviderRuntime
            && params?.managedServices
            ? withPluginInvocationServiceBindingAvailability(
                baseBinding,
                {
                    serviceId: 'managedServices',
                    availability: 'available',
                },
            )
            : baseBinding;
        retainResourceGeneration(
            'resources' in operation
                ? operation.resources
                : params?.resources,
            currentSeed.generation,
            currentSeed.plugin.id,
        );
        invocationGenerationScopes.set(
            managedGenerationKey(currentSeed.generation, currentSeed.plugin.id),
            Object.freeze({ generation: currentSeed.generation, pluginId: currentSeed.plugin.id }),
        );
        const diagnosticScope = {
            pluginId: currentSeed.plugin.id,
            generation: currentSeed.generation,
            correlationId: currentSeed.correlationId,
        };
        secretRedactor.beginInvocation(
            diagnosticScope,
            currentSeed.redactionLifetimeSignal ?? currentSeed.signal,
        );
        try {
            return createOperationServicesFactory(
                operation.filesystemRoots,
                operation.environment ?? Object.freeze({}),
                operation.systemTools,
                {
                    ...(operation.settingsDeclarations
                        ? { settingsDeclarations: operation.settingsDeclarations }
                        : {}),
                    ...(operation.eventDeclarationsByPluginId
                        ? { eventDeclarationsByPluginId: operation.eventDeclarationsByPluginId }
                        : {}),
                    ...(operation.activePluginIds
                        ? { activePluginIds: operation.activePluginIds }
                        : {}),
                    ...('resources' in operation
                        ? { resources: operation.resources ?? null }
                        : {}),
                    ...(operation.httpBinding
                        ? { httpBinding: operation.httpBinding }
                        : {}),
                    ...(operation.secretDeclarations
                        ? { secretDeclarations: operation.secretDeclarations }
                        : {}),
                    ...(operation.notificationCategories
                        ? { notificationCategories: operation.notificationCategories }
                        : {}),
                    ...(operation.managedProviderRuntime
                        ? { managedProviderRuntime: operation.managedProviderRuntime }
                        : {}),
                    ...(operation.exactPurposeBindingSubjectId
                        ? {
                            exactPurposeBindingSubjectId:
                                operation.exactPurposeBindingSubjectId,
                        }
                        : {}),
                    ...(operation.resolveExecutable
                        ? {
                            resolveExecutable:
                                operation.resolveExecutable,
                        }
                        : {}),
                },
            )(currentSeed, binding);
        } catch (error) {
            secretRedactor.completeInvocation(diagnosticScope);
            throw error;
        }
    };
    return Object.freeze({
        stableEventsBroker: broker,
        async pruneRetiredPluginSettings(
            previous: PluginSettingsRollbackDeclarations | undefined,
        ) {
            return await settingsHost?.pruneRetiredRollbackDeclarations?.(previous)
                ?? Object.freeze([]);
        },
        publishHostEvent(event: import('@happier-dev/protocol').HostSemanticEventV1): void {
            broker.publishHostEvent(event);
        },
        bindDeclaredEventSubscriptions(params: Readonly<{
            registrations: readonly DeclaredEventSubscriptionRegistration[];
            isGenerationCurrent(registration: DeclaredEventSubscriptionRegistration): boolean;
            isEffectCapable?(registration: DeclaredEventSubscriptionRegistration): boolean;
            createContext(input: Readonly<{
                pluginId: string;
                pluginVersion: string;
                generation: string;
                localId: string;
                sessionId?: string;
                signal: AbortSignal;
            }>): Readonly<{
                context: import('@happier-dev/plugin-sdk').PluginInvocationContext;
                complete(): void;
            }>;
        }>) {
            return bindDeclaredEventSubscriptions({ host: events, ...params });
        },
        async resolveHostBinding(...args: Parameters<typeof resolveBaseHostBinding>) {
            return await resolveBaseHostBinding(...args);
        },
        resolveHostPolicy,
        resolveInvocationHostPolicy,
        recordHostDiagnostic(
            seed: PluginInvocationServicesSeed,
            diagnostic: PluginDiagnosticData,
        ): void {
            resolveInvocationLogger(seed).diagnostic(diagnostic);
        },
        registerRawForRedaction(
            seed: PluginInvocationRawRedactionScope,
            value: string,
        ): void {
            secretRedactor.registerRaw({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            }, value);
        },
        bindDaemonPluginSecretAdministrationPort(
            seed: PluginInvocationServicesSeed,
        ) {
            return secretsHost?.bindDaemonPluginSecretAdministrationPort({
                pluginId: seed.plugin.id,
                signal: seed.signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            }) ?? null;
        },
        redactDiagnosticText(
            scope: Readonly<{ pluginId: string; generation: string; correlationId: string }>,
            value: string,
        ): string {
            return secretRedactor.redact(scope, value);
        },
        completeDiagnosticScope(
            scope: Readonly<{ pluginId: string; generation: string; correlationId: string }>,
        ): void {
            secretRedactor.completeInvocation(scope);
        },
        addOrdinaryAvailableServices,
        createOrdinaryServiceBinding,
        createOperationServices,
        createManagedProviderRuntimeInvocationServices(
            seed: Parameters<typeof createServicesFactory>[0],
            operation: PluginOperationServicesInput & Readonly<{
                managedProviderRuntime:
                    ManagedProviderRuntimeOperationBinding;
            }>,
        ): ManagedProviderRuntimeInvocationServices | null {
            const projectEndpointAccess = params?.managedServices
                ?.projectManagedProviderEndpointAccess;
            if (
                !projectEndpointAccess
            ) return null;
            const services = createOperationServices(seed, operation);
            if (
                services.availability('managedServices').status
                    !== 'available'
            ) return null;
            return Object.freeze({
                connectedAccounts: services.connectedAccounts,
                managedServices: services.managedServices,
                async projectEndpointAccess(input) {
                    return await projectEndpointAccess(input);
                },
            });
        },
        createServices(
            ...args: Parameters<typeof createServicesFactory>
        ): ReturnType<typeof createServicesFactory> {
            const [inputSeed] = args;
            const seed = attachCurrentPluginMaterializationResolver(inputSeed);
            retainResourceGeneration(
                params?.resources,
                seed.generation,
                seed.plugin.id,
            );
            invocationGenerationScopes.set(
                managedGenerationKey(seed.generation, seed.plugin.id),
                Object.freeze({ generation: seed.generation, pluginId: seed.plugin.id }),
            );
            const diagnosticScope = {
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            };
            secretRedactor.beginInvocation(
                diagnosticScope,
                seed.redactionLifetimeSignal ?? seed.signal,
            );
            try {
                return createServicesFactory(seed, args[1]);
            } catch (error) {
                secretRedactor.completeInvocation(diagnosticScope);
                throw error;
            }
        },
        retireConnectedAccountConsumers(): void {
            connectedAccountsHost?.retire();
        },
        async retireGeneration(generation: string, pluginId: string): Promise<void> {
            try {
                const results = await Promise.allSettled([
                    ...(params?.managedServices?.retireGeneration
                        ? [params.managedServices.retireGeneration(
                            generation,
                            pluginId,
                        )]
                        : []),
                    ...[
                        ...(resourceOwnersByGenerationKey.get(
                            managedGenerationKey(generation, pluginId),
                        )?.owners
                            ?? []),
                    ].map(async (owner) =>
                        owner.retirePlugin(pluginId)),
                ]);
                const failures = results
                    .filter((result): result is PromiseRejectedResult => (
                        result.status === 'rejected'
                    ))
                    .map((result) => result.reason);
                if (failures.length > 0) {
                    throw new AggregateError(
                        failures,
                        'Failed to retire plugin invocation service generation',
                    );
                }
            } finally {
                secretRedactor.retireGeneration(generation, pluginId);
                invocationGenerationScopes.delete(managedGenerationKey(generation, pluginId));
                resourceOwnersByGenerationKey.delete(
                    managedGenerationKey(generation, pluginId),
                );
            }
        },
        dispose(): Promise<void> {
            disposePromise ??= (async () => {
                const invocationScopes = [...invocationGenerationScopes.values()];
                invocationGenerationScopes.clear();
                for (const scope of invocationScopes) {
                    secretRedactor.retireGeneration(scope.generation, scope.pluginId);
                }
                const resources = [
                    ...resourceOwnersByGenerationKey.values(),
                ].flatMap(({ generation, pluginId, owners }) =>
                    [...owners].map((owner) =>
                        Object.freeze({ generation, pluginId, owner })));
                resourceOwnersByGenerationKey.clear();
                const results = await Promise.allSettled([
                    ...(params?.managedServices?.retireGeneration
                        ? invocationScopes.map(async (scope) => (
                            await params.managedServices!.retireGeneration!(
                                scope.generation,
                                scope.pluginId,
                            )
                        ))
                        : []),
                    ...(params?.mcp ? [params.mcp.dispose()] : []),
                    ...resources.map(async ({ pluginId, owner }) =>
                        owner.retirePlugin(pluginId)),
                ]);
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
