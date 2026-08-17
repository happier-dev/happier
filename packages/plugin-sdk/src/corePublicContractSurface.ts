import type { PluginApi } from './activation.js';
import type { AgentRuntimeFactoryContext, PluginInvocationContext } from './invocation.js';
import type { PluginServiceId, PluginServices } from './services/index.js';
import type {
    ManagedDependenciesService,
    ManagedServiceHandle,
    ManagedServiceSpec,
    ManagedServices,
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountCommonRuntime,
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
    PluginMcpContributionRef,
    PluginMcpElicitationMode,
    PluginMcpServerSummary,
    PluginNotificationCategorySummary,
    PluginNotificationChannelSummary,
    PluginNotificationPreferences,
    PluginProtocolClientSpecByKind,
    PluginSecretMutationResult,
    SessionWatchEvent,
    SessionWatchQuery,
    PluginSettingDescriptorBase,
    SubagentObservation,
} from './services/index.js';
import type {
    PluginMcpDiscoveredEndpoint,
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
    keyof SubagentObservation,
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
    | 'composerContent'
>>;
type _ServicePropertiesMustBeExact = AssertTrue<Equal<
    Exclude<keyof PluginServices, 'availability'>,
    PluginServiceId
>>;
type _NamedPacketServiceTypesMustResolve = [
    ManagedDependenciesService,
    ManagedServiceHandle,
    ManagedServiceSpec,
    ManagedServices,
    PluginConnectedAccountAuthCompletionResult,
    PluginConnectedAccountBindingEvent,
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountCommonRuntime,
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
    PluginMcpContributionRef,
    PluginMcpElicitationMode,
    PluginMcpServerSummary,
    PluginNotificationCategorySummary,
    PluginNotificationChannelSummary,
    PluginNotificationPreferences,
    PluginProtocolClientSpecByKind<'jsonRpc'>,
    PluginSecretMutationResult,
    SessionWatchEvent,
    SessionWatchQuery,
    PluginSettingDescriptorBase,
    SubagentObservation,
    PluginMcpDiscoveredEndpoint,
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
type _McpDiscoveredEndpointMustBeExact = AssertTrue<
    Equal<keyof PluginMcpDiscoveredEndpoint, 'id' | 'name' | 'kind' | 'url'>
>;

declare const sessionWatchEvent: SessionWatchEvent;
if (sessionWatchEvent.kind === 'snapshot') {
    const items: readonly import('./services/sessions.js').SessionSummary[] = sessionWatchEvent.items;
    void items;
/* @sdk-negative-type-case:src-corePublicContractSurface-ts-29:4oCUIG9ubHkgc25hcHNob3QgZXZlbnRzIGNhcnJ5IHRoZSBjb21wbGV0ZSBpdGVtIGNvbGxlY3Rpb24u:c2Vzc2lvbldhdGNoRXZlbnQuaXRlbTs */
void 0; /* @sdk-negative-type-case-end */
}
if (sessionWatchEvent.kind === 'upserted') {
    const item: import('./services/sessions.js').SessionSummary = sessionWatchEvent.item;
    void item;
/* @sdk-negative-type-case:src-corePublicContractSurface-ts-30:4oCUIG9ubHkgcmVtb3ZlZCBldmVudHMgY2FycnkgYSByZW1vdmVkIGlkLg:c2Vzc2lvbldhdGNoRXZlbnQuaWQ7 */
void 0; /* @sdk-negative-type-case-end */
}
if (sessionWatchEvent.kind === 'removed') {
    const id: string = sessionWatchEvent.id;
    void id;
/* @sdk-negative-type-case:src-corePublicContractSurface-ts-31:4oCUIHJlbW92ZWQgZXZlbnRzIGNhbm5vdCBjYXJyeSBhbiB1cHNlcnRlZCBpdGVtLg:c2Vzc2lvbldhdGNoRXZlbnQuaXRlbTs */
void 0; /* @sdk-negative-type-case-end */
}

/* @sdk-negative-type-case:src-corePublicContractSurface-ts-32:4oCUIGEgcmVtb3ZlZCBzZXNzaW9uIGV2ZW50IHJlcXVpcmVzIGl0cyByZW1vdmVkIGlkLg:Y29uc3QgcmVtb3ZlZFNlc3Npb25XaXRob3V0SWQ6IFNlc3Npb25XYXRjaEV2ZW50ID0geyBraW5kOiAncmVtb3ZlZCcsIHJldmlzaW9uOiAncjEnIH07 */
const removedSessionWithoutId = undefined as never; /* @sdk-negative-type-case-end */
void removedSessionWithoutId;
