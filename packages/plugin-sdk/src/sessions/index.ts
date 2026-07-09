import type { SessionId } from '@happier-dev/protocol';

import type { SubscriptionV1 } from '../context.js';
import type {
    SessionPermissionsServiceV1,
    SessionScopedServicesV1,
} from './scoped.js';

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
    ExternalSessionActivityResultV1,
    ExternalSessionCandidatePageV1,
    ExternalSessionFileFollowRuntimeServiceV1,
    ExternalSessionFollowLeaseV1,
    ExternalSessionTranscriptPageV1,
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
    watch(params: PluginSessionWatchParamsV1, onEvent: (event: PluginSessionWatchEventV1) => void): SubscriptionV1;
}

export type {
    SessionAuthServiceV1,
    SessionRuntimeAuthRefreshRequestV1,
    SessionRuntimeAuthRefreshResultV1,
    SessionRuntimeAuthServicesV1,
} from './auth.js';
export {
    createSessionRuntimeActivityPublisher,
    type CreateSessionRuntimeActivityPublisherOptions,
    type SessionRuntimeActivityPublisher,
    type SessionRuntimeActivityPublisherSourceInput,
} from './runtimeActivity.js';
export type {
    SessionAgentStateWriteRequestV1,
    SessionMetadataWriteRequestV1,
    SessionPermissionDecisionRequestV1,
    SessionPermissionDecisionResultV1,
    SessionPermissionDecisionV1,
    SessionPermissionFollowUpPromptDeliveryV1,
    SessionPermissionFollowUpPromptIntentV1,
    SessionPermissionModeV1,
    SessionPermissionPersistAllowRuleScopeV1,
    SessionPermissionPersistAllowRuleV1,
    SessionPermissionsServiceV1,
    SessionProviderAcceptedUserMessageDeliveryQueryV1,
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
    ExternalSessionCandidateHostAdapterV1,
    ExternalSessionCandidateHostListRequestV1,
    ExternalSessionCandidateHostRuntimeServiceV1,
    ExternalSessionCandidateV1,
    ExternalSessionFailureCodeV1,
    ExternalSessionFileFollowInputV1,
    ExternalSessionFollowTranscriptPathResolutionV1,
    ExternalSessionHostAdaptersContributionV1,
    ExternalSessionListCandidatesParamsV1,
    ExternalSessionListCandidatesResultV1,
    ExternalSessionProviderStoreKeyV1,
    ExternalSessionResolvedIdentityV1,
    ExternalSessionResolveFollowTranscriptPathRequestV1,
    ExternalSessionRuntimeHostAdapterParamsV1,
    ExternalSessionRuntimeContextV1,
    ExternalSessionSourceV1,
    ExternalSessionSurfaceV1,
    ExternalSessionTakeoverInputV1,
    ExternalSessionTakeoverResultV1,
    ExternalSessionTranscriptItemV1,
    ExternalSessionTranscriptPageParamsV1,
    ExternalSessionTranscriptPageResultV1,
    ExternalSessionTranscriptReadAfterParamsV1,
    ExternalSessionTranscriptReadAfterResultV1,
    ExternalSessionTranscriptStoreAdapterV1,
    ExternalSessionTranscriptStoreFollowRequestV1,
    ExternalSessionTranscriptStorePageRequestV1,
    ExternalSessionTranscriptStoreReadAfterRequestV1,
    ExternalSessionTranscriptStoreRuntimeServiceV1,
    ExternalSessionTranscriptUpdateV1,
    PluginExternalSessionsServiceV1,
    SessionStateUpdateV1,
} from './external.js';
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
