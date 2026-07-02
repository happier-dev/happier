import type { SessionId } from '@happier-dev/protocol';

import type { SubscriptionV1 } from '../context';
import type {
    SessionPermissionsServiceV1,
    SessionScopedServicesV1,
} from './scoped';

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
} from './auth';
export type {
    SessionAgentStateWriteRequestV1,
    SessionMetadataWriteRequestV1,
    SessionPermissionDecisionRequestV1,
    SessionPermissionDecisionResultV1,
    SessionPermissionDecisionV1,
    SessionPermissionModeV1,
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
} from './scoped';
export type {
    SessionMcpElicitDecisionV1,
    SessionMcpElicitRequestV1,
    SessionMcpElicitResultV1,
    SessionMcpServiceV1,
} from './mcp';
export type {
    ExternalSessionAttachParamsV1,
    ExternalSessionAttachResultV1,
    ExternalSessionCandidateV1,
    ExternalSessionListCandidatesParamsV1,
    ExternalSessionListCandidatesResultV1,
    ExternalSessionSourceV1,
    ExternalSessionTakeoverInputV1,
    ExternalSessionTakeoverResultV1,
    ExternalSessionTranscriptItemV1,
    ExternalSessionTranscriptPageParamsV1,
    ExternalSessionTranscriptPageResultV1,
    ExternalSessionTranscriptReadAfterParamsV1,
    ExternalSessionTranscriptReadAfterResultV1,
    ExternalSessionTranscriptUpdateV1,
    PluginExternalSessionsServiceV1,
} from './external';
export type {
    PluginSubagentsServiceV1,
    SubagentCompleteParamsV1,
    SubagentGetParamsV1,
    SubagentLifecycleDetailV1,
    SubagentListParamsV1,
    SubagentRefInputV1,
    SubagentRefV1,
    SubagentStatusUpdateParamsV1,
    SubagentStatusV1,
    SubagentWatchEventV1,
    SubagentWatchParamsV1,
} from './subagents';
