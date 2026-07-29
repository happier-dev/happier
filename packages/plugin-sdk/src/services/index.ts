import type { PluginServiceAvailability } from '../availability.js';
import type { PluginConnectedAccountsService } from './connectedAccounts.js';
import type {
    PluginEventsService,
    PluginLoggerService,
    PluginSecretsService,
    PluginSettingsService,
    PluginStorageService,
} from './core.js';
import type {
    PluginExecService,
    PluginFetchService,
    PluginFileSystemService,
    PluginManagedService,
} from './io.js';
import type {
    PluginMcpService,
    PluginNotificationsService,
    PluginResourcesService,
} from './resources.js';
import type { PluginSessionsService } from './sessions.js';

export type {
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountAuthFailure,
    PluginConnectedAccountAuthenticationAttempt,
    PluginConnectedAccountAuthenticationContext,
    PluginConnectedAccountAuthenticationModeRuntime,
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountCommonRuntime,
    PluginConnectedAccountConnectedResult,
    PluginConnectedAccountCredentialReader,
    PluginConnectedAccountCredentialStore,
    PluginConnectedAccountDeviceBeginResult,
    PluginConnectedAccountDevicePollResult,
    PluginConnectedAccountHealthResult,
    PluginConnectedAccountManualCompletion,
    PluginConnectedAccountMaterialization,
    PluginConnectedAccountMaterializationKind,
    PluginConnectedAccountMaterializationRequest,
    PluginConnectedAccountMutationContext,
    PluginConnectedAccountOAuthBeginRequest,
    PluginConnectedAccountOAuthBeginResult,
    PluginConnectedAccountOAuthCompletion,
    PluginConnectedAccountOutcomeUnknown,
    PluginConnectedAccountPendingResult,
    PluginConnectedAccountQuotaSnapshot,
    PluginConnectedAccountReadContext,
    PluginConnectedAccountReconciliationResult,
    PluginConnectedAccountRef,
    PluginConnectedAccountRefreshResult,
    PluginConnectedAccountRegistrationApi,
    PluginConnectedAccountRevocationResult,
    PluginConnectedAccountRuntime,
    PluginConnectedAccountRuntimeConfiguration,
    PluginConnectedAccountRuntimeConfigurationTarget,
    PluginConnectedAccountState,
    PluginConnectedAccountsService,
} from './connectedAccounts.js';
export type {
    PluginEventEmitResult,
    PluginEventRef,
    PluginEventsService,
    PluginLoggerService,
    PluginSecretMutationResult,
    PluginSecretStatus,
    PluginSecretsService,
    PluginSettingDescriptor,
    PluginSettingDescriptorBase,
    PluginSettingsChange,
    PluginSettingsService,
    PluginStorageConsistency,
    PluginStorageScopeService,
    PluginStorageService,
    PluginStorageTransaction,
} from './core.js';
export type {
    HttpMethod,
    ManagedDependencyReady,
    ManagedDependencyStatus,
    ManagedExecutableRef,
    ManagedServerCredential,
    ManagedServerHandle,
    ManagedServerHealthCheck,
    ManagedServerMode,
    ManagedServerSnapshot,
    ManagedServerSpec,
    ManagedServerStopResult,
    PluginAgentCliReadinessRequest,
    PluginAgentCliReadinessResult,
    PluginAgentCliReadinessService,
    PluginExecService,
    PluginExecSpawnRequest,
    PluginFetchCredentialBinding,
    PluginFetchService,
    PluginFileSystemService,
    PluginFramedBytesClient,
    PluginJsonRpcClient,
    PluginJsonStreamClient,
    PluginLoopbackWebSocketClientSpec,
    PluginLoopbackWebSocketEndpoint,
    PluginLoopbackWebSocketHandshake,
    PluginLoopbackWebSocketHeader,
    PluginLoopbackWebSocketJsonClient,
    PluginManagedDependenciesService,
    PluginManagedServersService,
    PluginManagedService,
    PluginPath,
    PluginProcessHandle,
    PluginProcessObservedTermination,
    PluginProcessOutput,
    PluginProcessResult,
    PluginProcessTerminationRequest,
    PluginProtocolClientByKind,
    PluginProtocolClientHandle,
    PluginProtocolClientKind,
    PluginProtocolClientSpec,
    PluginProtocolClientSpecByKind,
    PluginProtocolClientsService,
    PluginResolvedSystemTool,
    PluginSystemToolDiagnostic,
    PluginSystemToolResolveRequest,
    PluginSystemToolsService,
} from './io.js';
export type {
    PluginMcpClient,
    PluginMcpContributionRef,
    PluginMcpDiscoveredServer,
    PluginMcpDiscoveryProviderRef,
    PluginMcpElicitationMode,
    PluginMcpServerRef,
    PluginMcpServerSummary,
    PluginMcpService,
    PluginMcpTool,
    PluginNotificationBatchResult,
    PluginNotificationCategorySummary,
    PluginNotificationChannelSummary,
    PluginNotificationDeliveryResult,
    PluginNotificationPreferences,
    PluginNotificationsService,
    PluginResourceDescriptor,
    PluginResourceKind,
    PluginResourcesService,
} from './resources.js';
export type {
    PluginCurrentSessionService,
    PluginCurrentSessionWorkStatePublisher,
    PluginCurrentSessionWorkStateService,
    PluginSessionEvent,
    PluginSessionMediaPublishGeneratedRequest,
    PluginSessionMediaService,
    PluginSessionMediaSourceRoot,
    PluginSessionMessagePart,
    PluginSessionSendRequest,
    PluginSessionSendResult,
    PluginSessionService,
    PluginSessionSummary,
    PluginSessionWatchEvent,
    PluginSessionWatchQuery,
    PluginSessionWorkStateItem,
    PluginSessionWorkStateTruncation,
    PluginSessionsService,
    PluginSubagentObservation,
    PluginSubagentSummary,
    PluginSubagentsService,
} from './sessions.js';

export type PluginServiceId =
    | 'logger'
    | 'storage'
    | 'settings'
    | 'secrets'
    | 'events'
    | 'fetch'
    | 'fs'
    | 'exec'
    | 'managed'
    | 'sessions'
    | 'resources'
    | 'mcp'
    | 'notifications'
    | 'connectedAccounts';

export interface PluginServices {
    availability(serviceId: PluginServiceId): PluginServiceAvailability;
    readonly logger: PluginLoggerService;
    readonly storage: PluginStorageService;
    readonly settings: PluginSettingsService;
    readonly secrets: PluginSecretsService;
    readonly events: PluginEventsService;
    readonly fetch: PluginFetchService;
    readonly fs: PluginFileSystemService;
    readonly exec: PluginExecService;
    readonly managed: PluginManagedService;
    readonly sessions: PluginSessionsService;
    readonly resources: PluginResourcesService;
    readonly mcp: PluginMcpService;
    readonly notifications: PluginNotificationsService;
    readonly connectedAccounts: PluginConnectedAccountsService;
}
