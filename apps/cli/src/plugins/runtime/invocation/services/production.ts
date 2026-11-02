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
    resolvePluginInvocationExecutable,
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
    BeginPluginInvocationDiagnosticScope,
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
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { registerTargetActionDiagnosticInput } from '../diagnostics';
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
import type { StoredCredentials } from '@/persistence';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import {
    createPluginEphemeralStorageScope,
    createPluginStorageOwner,
    type PluginStorageOwnerScope,
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
import type { PluginAccountSettingsRecordAdapter } from './settings';
import { createProductionPluginSettingsHostFactory } from './settingsHost';
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
import { PluginError } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceProcessLocalPolicy, PreparedBackgroundServiceProcessLocalServices, PreparedBackgroundServiceProcessOperationServices } from '../../lifecycle/contributions/backgroundServiceProcessServices';
import { projectBackgroundServiceProcessProxiedServices } from '../../lifecycle/contributions/backgroundServiceProcessPolicy';

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
    prepareAgentNativeLaunch?: import('./exec').HostAgentNativeLaunchPreparation;
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
    connectedAccountsOwner?: StablePluginConnectedAccountsOwner;
    assertLaunchCurrent?: (signal: AbortSignal) => Promise<void>;
    resolveExecutable?: ResolvePluginExecutable;
    hostAccessRequests: readonly Readonly<{
        request: import('@happier-dev/protocol').PluginHostAccessRequestV2;
        required: boolean;
    }>[];
    /** The isolated Agent/session process has no duplex WebSocket wire. */
    executionRealm?: 'runner' | 'background-service-process';
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
    occurrenceId: string;
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
        readSpawnFailureLimits?: import('@/processes/spawnFailure/classifySpawnFailure').SpawnFailureLimitsReader;
        agentCli?: PluginAgentCliReadinessService;
        systemToolsForPlugin?: (pluginId: string) => ExecSystemToolServiceV1;
        resolveExecutable: ResolvePluginExecutable;
        resolvePath: Parameters<typeof createStablePluginExecService>[0]['resolvePath'];

agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
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
     * Reports a plugin whose declared settings could not be modelled. The
     * declaration set spans every plugin, so the host isolates the offender and
     * this is the only channel that makes its loss visible.
     */
    onPluginSettingsUnavailable?(input: Readonly<{ pluginId: string; error: unknown }>): void;
    /** Testable port for the one reserved Account Settings record owner. */
    accountSettingsRecordAdapter?: PluginAccountSettingsRecordAdapter;
    /**
     * Exact Account credential authority selected by a scoped executable
     * registry. Omission preserves the ordinary active-Account owner.
     */
    accountCredentialAuthority?: Readonly<{
        readCredentials: () => Promise<StoredCredentials | null>;
        actionsSettingsProvider: RuntimeActionSettingsProvider;
    }>;
    secretDeclarations?: readonly PluginSecretDeclaration[];
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[];
    isOccurrenceCurrent?: (action: ResolvedTargetAction) => boolean | Promise<boolean>;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    actionExecutor?: PluginActionsHostExecutor;
    invokeContributedAction?: InvokeContributedAction;
    targetedContributions?: StableTargetedContributionsOwner;
    composerContent?: StablePluginComposerContentOwner;
    demandBackgroundService?(target: Readonly<{
        pluginId: string; occurrenceId: string; localId: string; reason?: string;
    }>): import('@happier-dev/plugin-sdk/background-services').BackgroundServiceDemandHandle;
    /**
     * Host-private current materialization authority. The resolved runtime
     * registry owns this lookup; invocation service construction only consumes
     * its result to stamp the immediate plugin caller for nested Actions.
     */
    resolveCurrentPluginMaterializationRef?(
        pluginId: string,
    ): PluginMachineMaterializationRefV1 | null;
    resolveCurrentPluginExecutionOrigin?(
        pluginId: string,
        signal?: AbortSignal,
    ): Promise<import('@happier-dev/protocol').PluginMachineExecutionOriginV1 | null>;

healthChecks?: import('./unavailable').PluginInvocationServicesFactoryParams['healthChecks'];
}>) {
    const attachCurrentPluginCallerResolvers = (
        seed: PluginInvocationServicesSeed,
    ): PluginInvocationServicesSeed => {
        const pluginId = seed.plugin.id;
        const resolvedSeed = Object.freeze({
            ...seed,
            ...(!seed.resolveCurrentPluginMaterializationRef && params?.resolveCurrentPluginMaterializationRef
                ? { resolveCurrentPluginMaterializationRef: () => params.resolveCurrentPluginMaterializationRef!(pluginId) } : {}),
            ...(!seed.resolveCurrentPluginExecutionOrigin && params?.resolveCurrentPluginExecutionOrigin
                ? { resolveCurrentPluginExecutionOrigin: (signal?: AbortSignal) => params.resolveCurrentPluginExecutionOrigin!(pluginId, signal) } : {}),
        });
        // Caller enrichment preserves this invocation's logger and sequence.
        invocationLoggers.set(resolvedSeed, resolveInvocationLogger(seed));
        return resolvedSeed;
    };
    const loggerSink = params?.loggerSink ?? createFilePluginInvocationLogSink();
    const secretRedactor = createPluginInvocationSecretRedactor();
    const beginDiagnosticScope: BeginPluginInvocationDiagnosticScope = (scope, signal, input, secretInputPaths) => {
        secretRedactor.beginInvocation(scope, signal);
        // The approval projection is the declaration/SecretString classifier.
        // Enroll its actual confidential subtrees in the incumbent redactor;
        // diagnostic key spelling must not classify plugin operands.
        const projection = registerTargetActionDiagnosticInput(input, secretInputPaths,
            value => secretRedactor.registerRaw(scope, value));
        secretRedactor.registerConfidentialPaths(scope, projection.paths, projection.nonStringPaths);
    };
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
        ...(params?.accountCredentialAuthority
            ? {
                readCredentials: params.accountCredentialAuthority.readCredentials,
                actionsSettingsProvider:
                    params.accountCredentialAuthority.actionsSettingsProvider,
            }
            : {}),
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
                        occurrenceId: subscriptionIdentity.occurrenceId,
                        correlationId: subscriptionIdentity.correlationId,
                        surface: subscriptionIdentity.surface,
                        signal: listenerDiagnosticSignal,
                        isOccurrenceCurrent: () => true,
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
                        occurrenceId: publication.identity.occurrenceId,
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
    const accountCredentialAuthority = params?.accountCredentialAuthority;
    const storagePaths = params?.storagePaths;
    const createSettingsHost = createProductionPluginSettingsHostFactory({
        accountScoped: !!accountCredentialAuthority,
        ...(params?.accountSettingsRecordAdapter ? { accountSettingsRecordAdapter: params.accountSettingsRecordAdapter } : {}),
        ...(storagePaths ? { storagePaths } : {}),
        ...(params?.onPluginSettingsUnavailable ? { onPluginSettingsUnavailable: params.onPluginSettingsUnavailable } : {}),
        broker,
    });
    const settingsHost = params?.settingsDeclarations
        ? createSettingsHost(params.settingsDeclarations)
        : null;
    const accountSecretCustody = createAccountPluginSecretCustodyRouter(
        accountCredentialAuthority
            ? {
                readCredentials: accountCredentialAuthority.readCredentials,
                accountScopeKey: null,
            }
            : {},
    );
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
        ? createSecretsHost(params.secretDeclarations.filter((entry) => (
            !accountCredentialAuthority || entry.declaration.custody !== 'account'
        )))
        : null;
    const filesystemRoots = params?.filesystemRoots;
    const notificationsOwner = params?.notifications
        ? createStablePluginNotificationsOwner(params.notifications)
        : null;
    const createConnectedAccountsHost = (owner: StablePluginConnectedAccountsOwner) =>
        createStablePluginConnectedAccountsHost(owner, {
            registerRawForRedaction(seed, value) {
                secretRedactor.registerRaw({
                    pluginId: seed.plugin.id,
                    occurrenceId: seed.occurrenceId,
                    correlationId: seed.correlationId,
                }, value);
            },
            registerExactForRedaction(seed, value) {
                secretRedactor.registerExact({
                    pluginId: seed.plugin.id,
                    occurrenceId: seed.occurrenceId,
                    correlationId: seed.correlationId,
                }, value);
            },
        });
    const connectedAccountsHost = params?.connectedAccounts ? createConnectedAccountsHost(params.connectedAccounts) : null;
    const createServicesFactory = createPluginInvocationServicesFactory({
...(params?.healthChecks ? { healthChecks: params.healthChecks } : {}),

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
        ...(params?.exec ? { exec: {
            ...params.exec,
            // Ordinary daemon Actions need the host environment as the input
            // to ExecService's declared-key filter, just like scoped operations.
            environment: Object.freeze(Object.fromEntries(Object.entries(process.env)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))),
        } } : {}),
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
        resolveEphemeralStorageScope: (seed) => retainInvocationGenerationScope(
            seed.occurrenceId,
            seed.plugin.id,
        ).ephemeralStorage,
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
            connectedAccountsOwner?: StablePluginConnectedAccountsOwner;
            resolveExecutable?: ResolvePluginExecutable;
            prepareAgentNativeLaunch?: import('./exec').HostAgentNativeLaunchPreparation;
            assertLaunchCurrent?: (signal: AbortSignal) => Promise<void>;
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
                                isOccurrenceCurrent:
                                    seed.isOccurrenceCurrent,
                                registerRawForRedaction(value) {
                                    secretRedactor.registerRaw({
                                        pluginId: seed.plugin.id,
                                        occurrenceId: seed.occurrenceId,
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
        const admittedConnectedAccountsHost = overrides?.connectedAccountsOwner
            ? createConnectedAccountsHost(overrides.connectedAccountsOwner) : connectedAccountsHost;
        const operationConnectedAccountsHost =
            admittedConnectedAccountsHost && (overrides?.exactPurposeBindingSubjectId || overrides?.connectedAccountsOwner)
                ? Object.freeze({
                    bind(
                        seed: PluginInvocationServicesSeed,
                        scopes: Parameters<
                            typeof admittedConnectedAccountsHost.bind
                        >[1],
                    ) {
                        if (overrides?.connectedAccountsOwner) {
                            seed.signal.addEventListener('abort', () => admittedConnectedAccountsHost.retire(), { once: true });
                        }
                        return admittedConnectedAccountsHost.bind(seed, scopes, {
                            exactPurposeBindingSubjectId:
                                overrides.exactPurposeBindingSubjectId,
                        });
                    },
                    retire: admittedConnectedAccountsHost.retire,
                })
                : admittedConnectedAccountsHost;
        return createPluginInvocationServicesFactory({
...(params?.healthChecks ? { healthChecks: params.healthChecks } : {}),

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
...(params.exec.agentIsolation ? { agentIsolation: params.exec.agentIsolation } : {}),

                    readSpawnFailureLimits: params.exec.readSpawnFailureLimits,
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
                    ...(overrides?.prepareAgentNativeLaunch ? { prepareAgentNativeLaunch: overrides.prepareAgentNativeLaunch } : {}),
                    ...(overrides?.assertLaunchCurrent ? { assertLaunchCurrent: overrides.assertLaunchCurrent } : {}),
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
            resolveEphemeralStorageScope: (seed) => retainInvocationGenerationScope(
                seed.occurrenceId,
                seed.plugin.id,
            ).ephemeralStorage,
            ...(params?.daemonDatabase ? { daemonDatabase: params.daemonDatabase } : {}),
            ...(params?.accountStorage ? { accountStorage: params.accountStorage } : {}),
            ...(params?.now ? { now: params.now } : {}),
        });
    };
    const invocationGenerationScopes = new Map<string, Readonly<{
        occurrenceId: string;
        pluginId: string;
        ephemeralStorage: PluginStorageOwnerScope;
    }>>();
    const managedGenerationKey = (occurrenceId: string, pluginId: string): string => `${occurrenceId}\u0000${pluginId}`;
    const retainInvocationGenerationScope = (occurrenceId: string, pluginId: string) => {
        const key = managedGenerationKey(occurrenceId, pluginId);
        const retained = invocationGenerationScopes.get(key) ?? Object.freeze({
            occurrenceId,
            pluginId,
            ephemeralStorage: createPluginEphemeralStorageScope(),
        });
        invocationGenerationScopes.set(key, retained);
        return retained;
    };
    const resourceOwnersByGenerationKey = new Map<string, Readonly<{
        occurrenceId: string;
        pluginId: string;
        owners: Set<StablePluginResourcesOwner>;
    }>>();
    const retainResourceGeneration = (
        owner: StablePluginResourcesOwner | null | undefined,
        occurrenceId: string,
        pluginId: string,
    ): void => {
        if (!owner?.hasPlugin(pluginId)) return;
        const key = managedGenerationKey(occurrenceId, pluginId);
        const retained = resourceOwnersByGenerationKey.get(key)
            ?? Object.freeze({
                occurrenceId,
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
        occurrenceId: string,
        contributionQualifiedId: string,
        binding: PluginInvocationServiceBinding,
    ): PluginInvocationServiceBinding => params?.managedServices?.isAvailable({
        occurrenceId,
        contributionQualifiedId,
    }) === true
        ? withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'managedServices', availability: 'available' },
        )
        : binding;
    const createOrdinaryServiceBinding = (
        occurrenceId: string,
        id: string,
        hostAccessRequests: readonly Readonly<{
            request: import('@happier-dev/protocol').PluginHostAccessRequestV2;
            required: boolean;
        }>[] = [],
        contributionQualifiedId = id,
    ): PluginInvocationServiceBinding => addManagedServicesAvailability(
        occurrenceId,
        contributionQualifiedId,
        addOrdinaryAvailableServices(
            removeUnavailableHostBackedServices(createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                occurrenceId,
                id,
                hostAccessRequests,
            )),
        ),
    );
    const createTargetServiceBindingForRoots = (
        roots: PluginFileSystemRoots | undefined,
        connectedAccountsAvailable = connectedAccountsHost !== null,
    ): CreatePluginInvocationServiceBinding => (
        occurrenceId,
        id,
        hostAccessRequests = [],
        contributionQualifiedId = id,
    ) => {
        const processDeclarationsAvailable = params?.exec !== undefined;
        const resolved = roots && processDeclarationsAvailable
            ? createLoggerFilesystemEventsAndExecServiceBinding(
                occurrenceId,
                id,
                hostAccessRequests,
                roots,
                false,
                params?.exec !== undefined,
            )
            : roots
                ? createLoggerFilesystemAndEventsServiceBinding(
                    occurrenceId,
                    id,
                    hostAccessRequests,
                    roots,
                )
                : processDeclarationsAvailable
                    ? createLoggerEventsAndExecServiceBinding(
                        occurrenceId,
                        id,
                        hostAccessRequests,
                        false,
                        params?.exec !== undefined,
                    )
                    : createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                        occurrenceId,
                        id,
                        hostAccessRequests,
                    );
        const publicFilesystemBinding = addManagedServicesAvailability(
            occurrenceId,
            contributionQualifiedId,
            resolved,
        );
        const hostAvailable = connectedAccountsAvailable
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
        occurrenceId,
        id,
        hostAccessRequests = [],
        contributionQualifiedId = id,
    ) => {
        const pluginId = contributionQualifiedId.split('/', 1)[0] ?? '';
        const roots = filesystemRoots
            ?? params?.resolveFilesystemRoots?.(pluginId)
            ?? undefined;
        return createTargetServiceBindingForRoots(roots)(
            occurrenceId,
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
        ...(params?.isOccurrenceCurrent ? { isOccurrenceCurrent: params.isOccurrenceCurrent } : {}),
    });
    const createOperationServicesWithBinding = (
        seed: Parameters<typeof createServicesFactory>[0],
        operation: PluginOperationServicesInput,
    ): Readonly<{ services: PluginServices; binding: PluginInvocationServiceBinding; seed: PluginInvocationServicesSeed; hostAccess: ReturnType<ReturnType<typeof createPluginInvocationHostPolicyResolver>>['hostAccess'] }> => {
        const currentSeed = attachCurrentPluginCallerResolvers(seed);
        const policy = createPluginInvocationHostPolicyResolver({
            ...(params?.resolveOptionalAccess ? { resolveOptionalAccess: params.resolveOptionalAccess } : {}),
            createServiceBinding: createTargetServiceBindingForRoots(
                operation.filesystemRoots,
                operation.connectedAccountsOwner !== undefined || connectedAccountsHost !== null,
            ),
            sessionServiceAvailable: params?.sessions !== undefined,
        })({
            pluginId: currentSeed.plugin.id,
            occurrenceId: currentSeed.occurrenceId,
            qualifiedId: currentSeed.contribution.qualifiedId,
        }, {
            hostAccessRequests: operation.hostAccessRequests,
            surface: currentSeed.surface,
            signal: currentSeed.signal,
            ...(operation.executionRealm === undefined
                ? {}
                : { executionRealm: operation.executionRealm }),
        });
        const baseBinding = policy.serviceBinding;
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
            currentSeed.occurrenceId,
            currentSeed.plugin.id,
        );
        retainInvocationGenerationScope(currentSeed.occurrenceId, currentSeed.plugin.id);
        const diagnosticScope = {
            pluginId: currentSeed.plugin.id,
            occurrenceId: currentSeed.occurrenceId,
            correlationId: currentSeed.correlationId,
        };
        secretRedactor.beginInvocation(
            diagnosticScope,
            currentSeed.redactionLifetimeSignal ?? currentSeed.signal,
        );
        try {
            const services = createOperationServicesFactory(
                operation.filesystemRoots,
                operation.environment ?? Object.freeze({}),
                operation.systemTools,
                {
                    ...(operation.connectedAccountsOwner ? { connectedAccountsOwner: operation.connectedAccountsOwner } : {}),
                    ...(operation.prepareAgentNativeLaunch ? { prepareAgentNativeLaunch: operation.prepareAgentNativeLaunch } : {}),
                    ...(operation.assertLaunchCurrent ? { assertLaunchCurrent: operation.assertLaunchCurrent } : {}),
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
            return { services, binding, seed: currentSeed, hostAccess: policy.hostAccess };
        } catch (error) {
            secretRedactor.completeInvocation(diagnosticScope);
            throw error;
        }
    };
    const createOperationServices = (seed: PluginInvocationServicesSeed, operation: PluginOperationServicesInput): PluginServices => (
        createOperationServicesWithBinding(seed, operation).services
    );
    const prepareBackgroundServiceProcessLocalPolicy = async (
        seed: PluginInvocationServicesSeed,
        binding: PluginInvocationServiceBinding,
        operation?: PluginOperationServicesInput,
    ): Promise<PreparedBackgroundServiceProcessLocalServices> => {
        if (seed.occurrenceId !== binding.occurrenceId || seed.signal.aborted || !seed.isOccurrenceCurrent()) {
            throw new PluginError({ code: 'plugin_final_generation_retired', message: 'Background service occurrence is no longer current' });
        }
        if (operation?.managedProviderRuntime) {
            throw new PluginError({ code: 'background_service_process_managed_runtime_unavailable', message: 'Managed provider custody cannot be transferred to a background service child' });
        }
        const roots = operation?.filesystemRoots ?? filesystemRoots ?? params?.resolveFilesystemRoots?.(seed.plugin.id) ?? undefined;
        const { id, occurrenceId, availability, unavailableDiagnostics, filesystemScopes, filesystemRequestIds,
            processExecutables, processEnvKeys, processRequestIds, environmentRequestIds,
            networkOrigins, networkHostSuffixes, networkRequestIds, networkScopes,
            networkClientOrigins, networkClientHostSuffixes, networkClientRequestIds, networkClientScopes } = binding;
        const environment = operation ? operation.environment ?? {} : process.env;
        const localPolicy: BackgroundServiceProcessLocalPolicy = {
            binding: { id, occurrenceId, availability, unavailableDiagnostics, filesystemScopes, filesystemRequestIds,
                processExecutables, processEnvKeys, processRequestIds, environmentRequestIds,
                networkOrigins, networkHostSuffixes, networkRequestIds, networkScopes,
                networkClientOrigins, networkClientHostSuffixes, networkClientRequestIds, networkClientScopes },
            ...(roots ? { filesystemRoots: { pluginData: roots.pluginData, workspace: roots.workspace, projects: [...roots.projects] } } : {}),
            environment: Object.fromEntries((processEnvKeys ?? []).flatMap((key) => {
                const value = environment[key];
                return value === undefined ? [] : [[key, value]];
            })),
        };
        const systemTools = operation?.systemTools ?? params?.exec?.systemToolsForPlugin?.(seed.plugin.id);
        const http = params?.http;
        if (binding.availability.http === 'available' && !http?.bindWithAdapter) {
            throw new PluginError({ code: 'background_service_process_http_policy_unavailable', message: 'HTTP policy owner cannot place its physical transport in this child' });
        }
        return {
            localPolicy,
            services: { __backgroundServiceProcessLocal: {
                async writeLog(record) {
                    const invocationLogger = resolveInvocationLogger(seed);
                    if (record.level === 'diagnostic') {
                        // The private adapter carries SDK diagnostic operands; this canonical
                        // logger owns their invocation scope, redaction and bounds.
                        if (record.diagnostic) invocationLogger.diagnostic(record.diagnostic as unknown as PluginDiagnosticData);
                    } else {
                        invocationLogger[record.level](record.message ?? '', record.fields);
                    }
                },
                ...(systemTools ? { systemTools } : {}),
                ...(params?.exec?.agentCli ? { agentCli: params.exec.agentCli } : {}),
                ...(operation?.assertLaunchCurrent ? { assertLaunchCurrent: operation.assertLaunchCurrent } : {}),
                ...(params?.exec ? { resolveExecutable: async (executable) => {
                    if (seed.signal.aborted || !seed.isOccurrenceCurrent()) throw new PluginError({ code: 'plugin_final_generation_retired', message: 'Background service occurrence is no longer current' });
                    const exec = operation?.resolveExecutable ? { ...params.exec!, resolveExecutable: operation.resolveExecutable } : params.exec!;
                    const resolved = await resolvePluginInvocationExecutable(executable, seed.plugin.id, exec, systemTools);
                    if (seed.signal.aborted || !seed.isOccurrenceCurrent()) {
                        await resolved.release?.();
                        throw new PluginError({ code: 'plugin_final_generation_retired', message: 'Background service occurrence is no longer current' });
                    }
                    if (!resolved.release) return resolved;
                    const releaseExecutable = resolved.release;
                    let released = false;
                    const release = () => {
                        if (released) return;
                        released = true;
                        seed.signal.removeEventListener('abort', release);
                        releaseExecutable();
                    };
                    seed.signal.addEventListener('abort', release, { once: true });
                    seed.retainCleanup?.({ async dispose() { release(); } });
                    return { ...resolved, release };
                } } : {}),
                ...(http?.bindWithAdapter ? { http: {
                    request: (input, options, adapter) => http.bindWithAdapter!(seed, binding, adapter, operation?.httpBinding).request(input, options),
                    openWebSocket: (input, options, adapter) => http.bindWithAdapter!(seed, binding, adapter, operation?.httpBinding).openWebSocket(input, options),
                } } : {}),
            } },
        };
    };
    return Object.freeze({
        stableEventsBroker: broker,
        ...(notificationsOwner ? { notifications: notificationsOwner } : {}),
        publishHostEvent(event: import('@happier-dev/protocol').HostSemanticEventV1): void {
            broker.publishHostEvent(event);
        },
        bindDeclaredEventSubscriptions(params: Readonly<{
            registrations: readonly DeclaredEventSubscriptionRegistration[];
            isOccurrenceCurrent(registration: DeclaredEventSubscriptionRegistration): boolean;
            isEffectCapable?(registration: DeclaredEventSubscriptionRegistration): boolean;
            createContext(input: Readonly<{
                pluginId: string;
                pluginVersion: string;
                occurrenceId: string;
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
        beginDiagnosticScope,
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
                occurrenceId: seed.occurrenceId,
                correlationId: seed.correlationId,
            }, value);
        },
        bindDaemonPluginSecretAdministrationPort(
            seed: PluginInvocationServicesSeed,
        ) {
            return secretsHost?.bindDaemonPluginSecretAdministrationPort({
                pluginId: seed.plugin.id,
                signal: seed.signal,
                isOccurrenceCurrent: seed.isOccurrenceCurrent,
            }) ?? null;
        },
        redactDiagnosticText(
            scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
            value: string,
        ): string {
            return secretRedactor.redact(scope, value);
        },
        completeDiagnosticScope(
            scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>,
        ): void {
            secretRedactor.completeInvocation(scope);
        },
        addOrdinaryAvailableServices,
        createOrdinaryServiceBinding,
        createOperationServices,
        prepareBackgroundServiceProcessLocalPolicy,
        async prepareBackgroundServiceProcessOperationServices(seed: PluginInvocationServicesSeed, operation: PluginOperationServicesInput): Promise<PreparedBackgroundServiceProcessOperationServices> {
            const lifetime = new AbortController();
            const processOperation = { ...operation, executionRealm: 'background-service-process' as const };
            try {
                const admitted = createOperationServicesWithBinding({ ...seed, signal: AbortSignal.any([seed.signal, lifetime.signal]) }, processOperation);
                // Consumed Agent readers receive the available operation services, just
                // like ordinary Agent operations. Their manifest also declares runtime
                // needs (for example a terminal) that these reads never consume.
                // Runner admission still refuses unsupported required HostAccess;
                // individual unavailable services retain their fail-closed bindings.
                const local = await prepareBackgroundServiceProcessLocalPolicy(admitted.seed, admitted.binding, processOperation);
                return { localPolicy: local.localPolicy, services: {
                    ...projectBackgroundServiceProcessProxiedServices(admitted.services),
                    ...local.services,
                }, async dispose() { lifetime.abort(); } };
            } catch (error) {
                lifetime.abort();
                throw error;
            }
        },
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
            const resolvedSeed = attachCurrentPluginCallerResolvers(inputSeed);
            const seed: PluginInvocationServicesSeed = params?.demandBackgroundService
                ? { ...resolvedSeed, demandBackgroundService: (localId, reason) => params.demandBackgroundService!({
                    pluginId: resolvedSeed.plugin.id, occurrenceId: resolvedSeed.occurrenceId, localId, reason,
                }) }
                : resolvedSeed;
            retainResourceGeneration(
                params?.resources,
                seed.occurrenceId,
                seed.plugin.id,
            );
            retainInvocationGenerationScope(seed.occurrenceId, seed.plugin.id);
            const diagnosticScope = {
                pluginId: seed.plugin.id,
                occurrenceId: seed.occurrenceId,
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
        retireEphemeralStorageOccurrence(occurrenceId: string, pluginId: string): void {
            invocationGenerationScopes.delete(managedGenerationKey(occurrenceId, pluginId));
        },
        async retireGeneration(occurrenceId: string, pluginId: string): Promise<void> {
            try {
                const results = await Promise.allSettled([
                    ...(params?.managedServices?.retireGeneration
                        ? [params.managedServices.retireGeneration(
                            occurrenceId,
                            pluginId,
                        )]
                        : []),
                    ...[
                        ...(resourceOwnersByGenerationKey.get(
                            managedGenerationKey(occurrenceId, pluginId),
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
                        'Failed to retire plugin invocation service occurrenceId',
                    );
                }
            } finally {
                secretRedactor.retireGeneration(occurrenceId, pluginId);
                invocationGenerationScopes.delete(managedGenerationKey(occurrenceId, pluginId));
                resourceOwnersByGenerationKey.delete(
                    managedGenerationKey(occurrenceId, pluginId),
                );
            }
        },
        dispose(): Promise<void> {
            disposePromise ??= (async () => {
                const invocationScopes = [...invocationGenerationScopes.values()];
                invocationGenerationScopes.clear();
                for (const scope of invocationScopes) {
                    secretRedactor.retireGeneration(scope.occurrenceId, scope.pluginId);
                }
                const resources = [
                    ...resourceOwnersByGenerationKey.values(),
                ].flatMap(({ occurrenceId, pluginId, owners }) =>
                    [...owners].map((owner) =>
                        Object.freeze({ occurrenceId, pluginId, owner })));
                resourceOwnersByGenerationKey.clear();
                const results = await Promise.allSettled([
                    ...(params?.managedServices?.retireGeneration
                        ? invocationScopes.map(async (scope) => (
                            await params.managedServices!.retireGeneration!(
                                scope.occurrenceId,
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
