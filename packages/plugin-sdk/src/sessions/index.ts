import type { SessionId } from '@happier-dev/protocol';

import type {
    SessionPermissionsServiceV1,
    SessionScopedServicesV1,
} from './scoped.js';

type SessionWatchSubscription = Readonly<{ unsubscribe(): void }>;

export type {
    AgentExternalSessionCandidate,
    AgentExternalSessionLinkData,
    AgentExternalSessionLinkDataValue,
    AgentExternalSessionSource,
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsContribution,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsListCandidatesRequest,
    AgentExternalSessionsListCandidatesResult,
    AgentExternalSessionsPageTranscriptRequest,
    AgentExternalSessionsReadAfterDiagnostic,
    AgentExternalSessionsReadAfterTranscriptRequest,
    AgentExternalSessionsReadAfterTranscriptResult,
    AgentExternalSessionsResult,
    AgentExternalSessionsResolvedIdentity,
    AgentExternalSessionsResolveLinkedIdentityRequest,
    AgentExternalSessionsResolveLinkIdentityRequest,
    AgentExternalSessionsResolveSourceRequest,
    AgentExternalSessionsResolveSourceResult,
    AgentExternalSessionsTranscriptPage,
} from '../externalSessions.js';
export type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionObservationDescribeResourceRequest,
    AgentExternalSessionObservationObserveResourceRequest,
    AgentExternalSessionObservationReconcileLink,
    AgentExternalSessionObservationReconcileResourceRequest,
    ExternalAgentObservationLinkEvidenceBatchV1,
    ExternalAgentObservationLinkKeyV1,
    ExternalAgentObservationReconcilePurposeV1,
    ExternalAgentObservationReconcileRequestV1,
    ExternalAgentObservationReconcileResultV1,
    ExternalAgentObservationResourceDescriptorOutcomeV1,
    ExternalAgentObservationResourceGroupingV1,
    ExternalAgentObservationResourceDescriptorV1,
    ExternalAgentObservationResourceKeyV1,
    ExternalAgentObservationWatchFileChangesV1,
} from '../externalSessionObservation.js';
export {
    AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS,
    validateAgentExternalSessionTakeoverContribution,
    validateAgentExternalSessionTakeoverLaunchPlan,
    validateAgentExternalSessionTakeoverResolveLaunchRequest,
    validateAgentExternalSessionTakeoverResolveLaunchResult,
} from './externalSessionTakeover.js';
export type {
    AgentExternalSessionTakeoverContribution,
    AgentExternalSessionTakeoverLaunchPlan,
    AgentExternalSessionTakeoverResolveLaunchCallback,
    AgentExternalSessionTakeoverResolveLaunchRequest,
    AgentExternalSessionTakeoverResolveLaunchResult,
} from './externalSessionTakeover.js';
export {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
    validateAgentExternalSessionHookMapEventRequest,
    validateAgentExternalSessionHookMapEventResult,
    validateAgentExternalSessionHookResolveInstallationRequest,
    validateAgentExternalSessionHookResolveInstallationResult,
    validateAgentExternalSessionHooksContribution,
} from '../externalSessionHooks.js';
export type {
    AgentExternalSessionHookCustodiedEntryProjection,
    AgentExternalSessionHookInstallationVariant,
    AgentExternalSessionHookMapEventRequest,
    AgentExternalSessionHookMapEventResult,
    AgentExternalSessionHookMapEventValue,
    AgentExternalSessionHookResolveInstallationRequest,
    AgentExternalSessionHookResolveInstallationResult,
    AgentExternalSessionHookResolveInstallationValue,
    AgentExternalSessionHooksContribution,
    StrictJsonValue,
} from '../externalSessionHooks.js';

export type {
    ExternalSessionActivityV1,
    ExternalSessionTranscriptRawMessageV1,
    ExternalSessionsSource,
    RuntimeDescriptorMetadataCarrier,
    RuntimeDescriptorV1,
    SessionHandoffResumePlan,
    SessionMetadata,
    SessionStateCapabilitiesV1,
} from '@happier-dev/protocol';
export {
    ExternalSessionsSourceSchema,
    buildLinkedExternalSessionMetadataV1,
    removeLinkedExternalSessionMetadataV1,
    readLinkedExternalSessionV1FromMetadata,
    readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';
export {
    isSlashCommandSupported,
    normalizeSlashCommandName,
    readSlashCommandNames,
} from '@happier-dev/protocol';
export {
    createSessionStateSyncEngine,
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
    readSessionMetadataRuntimeDescriptor,
    readMetadataAliasValue,
    resolveFingerprintPublication,
    resolveVendorResumeIdFromSessionMetadata,
    rollbackFingerprintPublication,
    type MetadataUpdatePort,
    type SessionStateProviderFieldHandler,
    type SessionStateFieldWriteValue,
} from '@happier-dev/agents';
export type {
    BackendSessionLaunchHintsV1,
    BackendSurfaceResultV1,
    ExternalSessionCandidatePageV1,
    ExternalSessionTranscriptPageV1,
    ForkRequestV1,
    ForkResultV1,
    ForkSurfaceV1,
    HandoffSurfaceV1,
} from '@happier-dev/agents';
export {
    applyRuntimeDescriptorSessionMetadata,
    buildProviderSessionIdSessionMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';

export type PluginSessionRefV1 = Readonly<{
    sessionId: SessionId;
    title?: string | null;
    metadata?: Readonly<Record<string, unknown>>;
    agentState?: Readonly<Record<string, unknown>>;
}>;

export type PluginSessionListParamsV1 = Readonly<{
    currentOnly?: boolean;
}>;

export type PluginSessionGetParamsV1 = SessionId | Readonly<{
    sessionId: SessionId;
}>;

export type PluginSessionWatchParamsV1 = Readonly<{
    sessionId?: SessionId;
}>;

export type PluginSessionWatchEventV1 = Readonly<{
    kind: 'snapshot' | 'changed' | 'removed';
    sessions?: readonly PluginSessionRefV1[];
    session?: PluginSessionRefV1;
    sessionId?: SessionId;
}>;

export interface PluginSessionsPermissionsServiceV1 {
    forSession(sessionId: SessionId): Promise<SessionPermissionsServiceV1 | null>;
}

export interface PluginSessionsServiceV1 extends Omit<SessionScopedServicesV1, 'permissions'> {
    readonly current: SessionScopedServicesV1;
    readonly permissions: PluginSessionsPermissionsServiceV1;
    list(params?: PluginSessionListParamsV1): Promise<readonly PluginSessionRefV1[]>;
    get(params: PluginSessionGetParamsV1): Promise<SessionScopedServicesV1 | null>;
    watch(
        params: PluginSessionWatchParamsV1,
        onEvent: (event: PluginSessionWatchEventV1) => void,
    ): SessionWatchSubscription;
}

export type {
    SessionAuthServiceV1,
    SessionRuntimeAuthRefreshRequestV1,
    SessionRuntimeAuthRefreshResultV1,
    SessionRuntimeAuthServicesV1,
} from './auth.js';
export type {
    SessionAgentStateWriteRequestV1,
    SessionMetadataWriteRequestV1,
    SessionMediaPublishGeneratedRequestV1,
    SessionMediaServiceV1,
    SessionMediaSourceRootV1,
    SessionPermissionDecisionRequestV1,
    SessionPermissionDecisionResultV1,
    SessionPermissionDecisionV1,
    SessionPermissionFollowUpPromptDeliveryV1,
    SessionPermissionFollowUpPromptIntentV1,
    SessionPermissionModeV1,
    SessionPermissionPersistAllowRuleScopeV1,
    SessionPermissionPersistAllowRuleV1,
    SessionPermissionsServiceV1,
    SessionScopedAgentMessageOptionsV1,
    SessionScopedSendAgentMessageRequestV1,
    SessionScopedSendRequestV1,
    SessionScopedSendResultV1,
    SessionScopedSendSessionEventRequestV1,
    SessionScopedSendUserTextRequestV1,
    SessionScopedServicesV1,
    SessionScopedSubscribeRequestV1,
    SessionScopedSubscriptionEventV1,
    SessionStateFieldWriteRequestV1,
    SessionSystemRecordReadRequestV1,
    SessionSystemRecordReadResultV1,
    SessionSystemRecordWriteRequestV1,
} from './scoped.js';
export type {
    SessionMcpElicitDecisionV1,
    SessionMcpElicitRequestV1,
    SessionMcpElicitResultV1,
    SessionMcpServiceV1,
} from './mcp.js';
export type {
    ExternalSessionAttachParamsV1,
    ExternalSessionAttachResultV1,
    ExternalSessionCandidateV1,
    ExternalSessionFailureCodeV1,
    ExternalSessionListCandidatesParamsV1,
    ExternalSessionListCandidatesResultV1,
    ExternalSessionResolvedIdentityV1,
    ExternalSessionSourceV1,
    ExternalSessionTakeoverInputV1,
    ExternalSessionTakeoverResultV1,
    ExternalSessionTranscriptItemV1,
    ExternalSessionTranscriptPageParamsV1,
    ExternalSessionTranscriptPageResultV1,
    ExternalSessionTranscriptReadAfterParamsV1,
    ExternalSessionTranscriptReadAfterResultV1,
    ExternalSessionTranscriptUpdateV1,
    SessionStateUpdateV1,
} from './external.js';
export { deriveExternalSessionActivity } from './external.js';
export type {
    ParticipantMessageV1,
    ParticipantRecipientV1,
    PluginSubagentsServiceV1,
    SubagentCommandV1,
    SubagentCompleteParamsV1,
    SubagentGetParamsV1,
    SubagentLifecycleDetailV1,
    SubagentLaunchV1,
    SubagentListParamsV1,
    SubagentRefInputV1,
    SubagentRefV1,
    SubagentStatusUpdateParamsV1,
    SubagentStatusV1,
    SubagentWatchEventV1,
    SubagentWatchParamsV1,
} from './subagents.js';
