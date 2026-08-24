/** @moduleRealm daemon */
import type { PluginOperationAvailability } from '../availability.js';
import type { ActionsService } from '../actions/service.js';
import type { ConnectedAccountsService } from '../connectedAccounts.js';
import type { ComposerContentService } from './composerContent.js';
import type { InteractionsService } from '../interactions.js';
import type { EventsService } from '../events.js';
import type {
    LoggerService,
    SettingsService,
} from './core.js';
import type {
    HttpService,
    FileSystemService,
} from './io.js';
import type { ExecService } from '../exec.js';
import type { SecretsService } from '../secrets.js';
import type { StorageService } from '../storage.js';
import type { ManagedServices } from '../managed-services/contract.js';
import type { ProvidersService } from '../providers/projections.js';
import type {
    McpService,
    NotificationsService,
    ResourcesService,
} from './resources.js';
import type { SessionsService } from './sessions.js';
import type { TargetedContributionsService } from './targetedContributions.js';

export type {
    ApprovalQueueListItem,
    ApprovalQueueQuery,
    ApprovalQueueRequest,
    ApprovalQueueRequestResult,
    ApprovalQueueService,
    ApprovalQueueSnapshot,
    ApprovalRequest,
    ApprovalRequestStatus,
    InteractionTerminalStatusV1,
    InteractionTransientApprovalAuthorRequestV1,
    InteractionTransientApprovalResultV1,
    InteractionTransientAuthorQuestionV1,
    InteractionTransientAuthorRequestV1,
    InteractionTransientChoiceSelectionV1,
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
    InteractionTransientResultV1,
    InteractionOptions,
    InteractionSeverity,
    InteractionsService,
    PresentationService,
    UiWidget,
} from '../interactions.js';
export type {
    AdmittedTargetedOperationExecutionHandle,
    AdmittedTargetedOperationIdentity,
} from '../actions/admittedTargetedOperation.js';
export type {
    ActionsService,
    PluginActionInputById,
    PluginActionResultById,
    PluginInvocableActionId,
    SessionTranscriptGetExternalShareableInputV1,
    SessionTranscriptGetExternalShareableResultV1,
} from '../actions/service.js';
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
    PluginConnectedAccountCredentialStore,
    PluginConnectedAccountDeviceBeginResult,
    PluginConnectedAccountDevicePollResult,
    PluginConnectedAccountHealthResult,
    PluginConnectedAccountManualCompletion,
    PluginConnectedAccountMaterialization,
    PluginConnectedAccountMaterializationOptions,
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
    ConnectedAccountsService,
} from './connectedAccounts.js';
export type {
    TargetedContributionObservation,
    TargetedContributionPointRef,
    TargetedContributionSnapshot,
    TargetedContributionsService,
} from './targetedContributions.js';

export type {
    PluginConnectedAccountMaterializationKind,
} from '../connectedAccounts.js';
export type {
    LoggerService,
    PluginLoggerService,
    PluginSettingDescriptor,
    PluginSettingDescriptorBase,
    PluginSettingsChange,
    PluginSettingsMutationResult,
    PluginSettingsSnapshot,
    ScopedSettingsService,
    SettingsScopeRef,
    SettingsService,
} from './core.js';
export type {
    SecretMutationResult as PluginSecretMutationResult,
    SecretStatus as PluginSecretStatus,
    SecretsService,
} from '../secrets.js';
export type {
    AccountKvEntry,
    AccountKvListItem,
    AccountKvService,
    AccountKvTransaction,
    PluginAccountStorageScope,
    StorageConsistency,
    StorageScopeService,
    StorageService,
    StorageTransaction,
} from '../storage.js';
export type {
    DaemonDatabase,
    DaemonDatabaseExecutionResult,
    DaemonDatabaseIncumbentQueryFixture,
    DaemonDatabaseMigration,
    DaemonDatabaseMigrationDeclaration,
    DaemonDatabaseMigrationReadTransaction,
    DaemonDatabaseMigrationTransaction,
    DaemonDatabaseOperationOptions,
    DaemonDatabaseReadTransaction,
    DaemonDatabaseRow,
    DaemonDatabaseService,
    DaemonDatabaseStorageScope,
    DaemonDatabaseTransaction,
    DaemonDatabaseValue,
} from '../storage/database.js';
export type {
    EventSubscriptionTarget,
    EventsService,
    HostEventEnvelope,
    HostEventId,
    HostEventPayloadById,
    HostEventScope,
    HostEventScopeById,
    HostEventTarget,
    HostEvents,
    PluginEventEmitResult,
    PluginEventEnvelope,
    PluginEvents,
} from '../events.js';
export type {
    HttpMethod,
    ManagedExecutableRef,
    PluginAgentCliReadinessRequest,
    PluginAgentCliReadinessResult,
    PluginExecSpawnRequest,
    PluginFetchCredentialBinding,
    HttpService,
    PluginWebSocketClose,
    PluginWebSocketConnection,
    PluginWebSocketHeader,
    PluginWebSocketMessage,
    PluginWebSocketOpenInput,
    FileSystemService,
    PluginFramedBytesClient,
    PluginJsonRpcClient,
    PluginJsonStreamClient,
    PluginLoopbackWebSocketClientSpec,
    PluginLoopbackWebSocketEndpoint,
    PluginLoopbackWebSocketHandshake,
    PluginLoopbackWebSocketHeader,
    PluginLoopbackWebSocketJsonClient,
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
    ProtocolClientsService,
} from './io.js';
export type {
    AgentCliReadinessService as PluginAgentCliReadinessService,
    ExecService,
    ResolvedSystemTool as PluginResolvedSystemTool,
    SystemToolDiagnostic as PluginSystemToolDiagnostic,
    SystemToolResolveRequest as PluginSystemToolResolveRequest,
    SystemToolsService as PluginSystemToolsService,
} from '../exec.js';
export { ManagedServiceLocalIdSchema } from '../managed-services/contract.js';
export type {
    ConnectedAccountMaterializationRequest,
    ExecSpawnRequest,
    ManagedDependenciesService,
    ManagedDependencyReady,
    ManagedDependencyStatus,
    ManagedProviderEndpoint,
    ManagedProviderRuntime,
    ManagedProviderRuntimeContext,
    ManagedProviderStartRequest,
    ManagedServiceAttachClientAccess,
    ManagedServiceClientAccess,
    ManagedServiceCredentialBinding,
    ManagedServiceErrorCode,
    ManagedServiceHandle,
    ManagedServiceHealthCheck,
    ManagedServiceLocalId,
    ManagedServiceMaterializationInjection,
    ManagedServiceSnapshot,
    ManagedServiceSpec,
    ManagedServices,
    ProviderLocalId,
    ProvidersRegistrationApi,
} from '../managed-services/contract.js';
export type {
    PluginMcpAnnotations,
    PluginMcpBlobResourceContents,
    PluginMcpClient,
    PluginMcpContributionRef,
    PluginMcpDiscoveredServer,
    PluginMcpDiscoverySourceRef,
    PluginMcpElicitationMode,
    PluginMcpGetPromptResult,
    PluginMcpIcon,
    PluginMcpPageOptions,
    PluginMcpPrompt,
    PluginMcpPromptArgument,
    PluginMcpPromptContent,
    PluginMcpPromptMessage,
    PluginMcpPromptPage,
    PluginMcpReadResourceResult,
    PluginMcpResource,
    PluginMcpResourceContents,
    PluginMcpResourcePage,
    PluginMcpResourceTemplate,
    PluginMcpResourceTemplatePage,
    PluginMcpResourceUpdatedEvent,
    PluginMcpServerRef,
    PluginMcpServerSummary,
    McpService,
    PluginMcpTool,
    PluginMcpToolPageOptions,
    PluginMcpTextResourceContents,
    PluginNotificationBatchResult,
    PluginNotificationCategorySummary,
    PluginNotificationChannelSummary,
    PluginNotificationDeliveryResult,
    PluginNotificationPreferences,
    PluginDynamicResourceRuntime,
    PluginDynamicResourceInvocationOptionsV1,
    NotificationsService,
    PluginResourceDescriptor,
    PluginResourceKind,
    ResourcesService,
} from './resources.js';
export type {
    WorkStatePublisher,
    WorkStateService,
    SessionEvent,
    SessionAuthService,
    SessionRuntimeAuthRefreshRequest,
    CurrentSessionHandle,
    SessionMediaPublishGeneratedRequest,
    SessionMediaService,
    SessionMediaSourceRoot,
    SessionMessagePart,
    SessionSendAttachment,
    SessionSendRequest,
    SessionSendResult,
    SessionHandle,
    SessionSystemRecord,
    SessionSystemRecordAddress,
    SessionSystemRecordDeleteRequest,
    SessionSystemRecordListQuery,
    SessionSystemRecordPage,
    SessionSystemRecordReadRequest,
    SessionSystemRecordRevision,
    SessionSystemRecordUpsertRequest,
    SessionSummary,
    SessionWatchEvent,
    SessionWatchQuery,
    WorkStateItem,
    WorkStateTruncation,
    SessionsService,
    SubagentObservation,
    SubagentSummary,
    SubagentsService,
} from './sessions.js';
export type {
    ComposerContentCapabilitiesV1,
    ComposerContentService,
    ComposerContentStageMediaRequestV1,
} from './composerContent.js';

export type PluginServiceId =
    | 'logger'
    | 'storage'
    | 'settings'
    | 'secrets'
    | 'events'
    | 'http'
    | 'fs'
    | 'exec'
    | 'providers'
    | 'managedServices'
    | 'sessions'
    | 'resources'
    | 'mcp'
    | 'notifications'
    | 'connectedAccounts'
    | 'actions'
    | 'targetedContributions'
    | 'interactions'
    | 'composerContent';

export interface PluginServices {
    availability(serviceId: PluginServiceId): PluginOperationAvailability;
    readonly logger: LoggerService;
    readonly storage: StorageService;
    readonly settings: SettingsService;
    readonly secrets: SecretsService;
    readonly events: EventsService;
    readonly http: HttpService;
    readonly fs: FileSystemService;
    readonly exec: ExecService;
    readonly providers: ProvidersService;
    readonly managedServices: ManagedServices;
    readonly sessions: SessionsService;
    readonly resources: ResourcesService;
    readonly mcp: McpService;
    readonly notifications: NotificationsService;
    readonly connectedAccounts: ConnectedAccountsService;
    readonly actions: ActionsService;
    readonly targetedContributions: TargetedContributionsService;
    readonly interactions: InteractionsService;
    readonly composerContent: ComposerContentService;
}
