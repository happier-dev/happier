import type { PluginApi } from './activation.js';
import type { AgentRuntimeFactoryContext, PluginInvocationContext } from './invocation.js';
import type { PluginServiceId, PluginServices } from './services/index.js';
import type {
    ManagedServerStopResult,
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountCommonRuntime,
    PluginConnectedAccountCredentialReader,
    PluginConnectedAccountDeviceBeginResult,
    PluginConnectedAccountDevicePollResult,
    PluginConnectedAccountManualCompletion,
    PluginConnectedAccountOAuthBeginRequest,
    PluginConnectedAccountOAuthBeginResult,
    PluginConnectedAccountOAuthCompletion,
    PluginConnectedAccountQuotaSnapshot,
    PluginConnectedAccountRefreshResult,
    PluginConnectedAccountRevocationResult,
    PluginFetchCredentialBinding,
    PluginManagedDependenciesService,
    PluginManagedServersService,
    PluginMcpContributionRef,
    PluginMcpElicitationMode,
    PluginMcpServerSummary,
    PluginNotificationCategorySummary,
    PluginNotificationChannelSummary,
    PluginNotificationPreferences,
    PluginProtocolClientSpecByKind,
    PluginSecretMutationResult,
    PluginSessionWatchEvent,
    PluginSessionWatchQuery,
    PluginSettingDescriptorBase,
    PluginSubagentObservation,
} from './services/index.js';
import type {
    PluginInterceptorResult,
    PluginMcpDiscoveryRequest,
    PluginMcpDiscoveryResult,
    PluginMcpToolCallContent,
    PluginMcpToolCallRequest,
    PluginNotificationSendResult,
} from './activation.js';

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type Equal<TLeft, TRight> =
    (<T>() => T extends TLeft ? 1 : 2) extends
    (<T>() => T extends TRight ? 1 : 2) ? true : false;

type _ActivationMustNotCarryServices = AssertNever<Extract<keyof PluginApi, 'services' | 'config' | 'features'>>;
type _FactoryContextMustNotCarryServices = AssertNever<Extract<keyof AgentRuntimeFactoryContext, 'services' | 'session'>>;
type _FactoryContextIdentityMustBeExact = AssertTrue<Equal<
    keyof AgentRuntimeFactoryContext,
    'plugin' | 'agent' | 'signal'
>>;
type _FactoryContextAgentIdentityMustBeExact = AssertTrue<Equal<
    AgentRuntimeFactoryContext['agent'],
    Readonly<{ id: string }>
>>;
type _InvocationMustCarryServices = AssertTrue<PluginInvocationContext extends Readonly<{ services: PluginServices }> ? true : false>;
type _CurrentSessionUiMechanicsMustRemainPrivate = AssertNever<Extract<
    keyof PluginServices['sessions']['current'],
    'interactions' | 'presentation'
>>;
type _SubagentOperationsMustBeIntentOriented = AssertTrue<Equal<
    Exclude<keyof PluginServices['sessions']['subagents'], 'capabilities' | 'list' | 'get' | 'watch'>,
    'observe'
>>;
type _SubagentObservationMustNotExposeLedgerMechanics = AssertTrue<Equal<
    keyof PluginSubagentObservation,
    'observationId' | 'groupId' | 'status' | 'detail'
>>;
type _SubagentCapabilitiesMustUseIntentVocabulary = AssertTrue<Equal<
    keyof ReturnType<PluginServices['sessions']['subagents']['capabilities']>,
    'list' | 'observe' | 'watch'
>>;
type _ServiceIdsMustBeExact = AssertTrue<Equal<
    PluginServiceId,
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
    | 'connectedAccounts'
>>;
type _ServicePropertiesMustBeExact = AssertTrue<Equal<
    Exclude<keyof PluginServices, 'availability'>,
    PluginServiceId
>>;
type _NamedPacketServiceTypesMustResolve = [
    ManagedServerStopResult,
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountCommonRuntime,
    PluginConnectedAccountCredentialReader,
    PluginConnectedAccountDeviceBeginResult,
    PluginConnectedAccountDevicePollResult,
    PluginConnectedAccountManualCompletion,
    PluginConnectedAccountOAuthBeginRequest,
    PluginConnectedAccountOAuthBeginResult,
    PluginConnectedAccountOAuthCompletion,
    PluginConnectedAccountQuotaSnapshot,
    PluginConnectedAccountRefreshResult,
    PluginConnectedAccountRevocationResult,
    PluginFetchCredentialBinding,
    PluginManagedDependenciesService,
    PluginManagedServersService,
    PluginMcpContributionRef,
    PluginMcpElicitationMode,
    PluginMcpServerSummary,
    PluginNotificationCategorySummary,
    PluginNotificationChannelSummary,
    PluginNotificationPreferences,
    PluginProtocolClientSpecByKind<'jsonRpc'>,
    PluginSecretMutationResult,
    PluginSessionWatchEvent,
    PluginSessionWatchQuery,
    PluginSettingDescriptorBase,
    PluginSubagentObservation,
    PluginInterceptorResult,
    PluginMcpDiscoveryRequest,
    PluginMcpDiscoveryResult,
    PluginMcpToolCallContent,
    PluginMcpToolCallRequest,
    PluginNotificationSendResult,
];
type _NamedPacketServiceTypesAreReachable = AssertTrue<
    _NamedPacketServiceTypesMustResolve extends readonly unknown[] ? true : false
>;

type PluginMcpDiscoveryWarning = NonNullable<
    PluginMcpDiscoveryResult['warnings']
>[number];
type _McpDiscoveryWarningMustCarryOnlyLeafDiagnosticData = AssertTrue<
    Equal<keyof PluginMcpDiscoveryWarning, 'code' | 'path' | 'detail'>
>;

declare const sessionWatchEvent: PluginSessionWatchEvent;
if (sessionWatchEvent.kind === 'snapshot') {
    const items: readonly import('./services/sessions.js').PluginSessionSummary[] = sessionWatchEvent.items;
    void items;
    // @ts-expect-error — only snapshot events carry the complete item collection.
    sessionWatchEvent.item;
}
if (sessionWatchEvent.kind === 'upserted') {
    const item: import('./services/sessions.js').PluginSessionSummary = sessionWatchEvent.item;
    void item;
    // @ts-expect-error — only removed events carry a removed id.
    sessionWatchEvent.id;
}
if (sessionWatchEvent.kind === 'removed') {
    const id: string = sessionWatchEvent.id;
    void id;
    // @ts-expect-error — removed events cannot carry an upserted item.
    sessionWatchEvent.item;
}

// @ts-expect-error — a removed session event requires its removed id.
const removedSessionWithoutId: PluginSessionWatchEvent = { kind: 'removed', revision: 'r1' };
void removedSessionWithoutId;
type SessionServiceExports = keyof typeof import('./services/sessions.js');
type EventServiceExports = keyof typeof import('./services/core.js');
type IoServiceExports = keyof typeof import('./services/io.js');
type ResourceServiceExports = keyof typeof import('./services/resources.js');
type ConnectedAccountServiceExports = keyof typeof import('./services/connectedAccounts.js');
type _DeferredCapacityConstantsMustRemainPrivate = AssertNever<Extract<
    SessionServiceExports
    | EventServiceExports
    | IoServiceExports
    | ResourceServiceExports
    | ConnectedAccountServiceExports,
    | 'MAX_PLUGIN_EVENT_PENDING_DELIVERIES_PER_SUBSCRIPTION'
    | 'MAX_PLUGIN_EVENT_PENDING_BYTES_PER_SUBSCRIPTION'
    | 'MAX_PLUGIN_PROTOCOL_PENDING_CALLBACKS'
    | 'MAX_PLUGIN_PROTOCOL_PENDING_CALLBACK_BYTES'
    | 'MAX_MANAGED_SERVER_HANDLES_PER_GENERATION'
    | 'MAX_PLUGIN_SESSION_PRESENTATION_COMPOSER_CODE_UNITS'
    | 'MAX_PLUGIN_SESSION_PRESENTATION_STATE_CODE_UNITS'
    | 'MAX_AGENT_WORK_STATE_SOURCE_JSON_BYTES'
    | 'MAX_PLUGIN_SESSION_SEND_IDEMPOTENCY_RECORDS'
    | 'MAX_PLUGIN_SUBAGENT_IDEMPOTENCY_RECORDS'
    | 'MAX_PLUGIN_NOTIFICATION_IDEMPOTENCY_RECORDS'
    | 'PLUGIN_SESSION_SEND_IDEMPOTENCY_RETENTION_MS'
    | 'PLUGIN_SUBAGENT_IDEMPOTENCY_RETENTION_MS'
    | 'HOST_CONNECTED_ACCOUNT_UNKNOWN_JOURNAL_BYTES'
>>;
