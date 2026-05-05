import type { SessionId } from '@happier-dev/protocol';

import type { SubscriptionV1 } from '../context';
import type { SessionScopedServicesV1 } from './scoped';

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

export interface PluginSessionsServiceV1 extends SessionScopedServicesV1 {
    list(params?: PluginSessionListParamsV1): Promise<readonly PluginSessionRefV1[]>;
    get(params: PluginSessionGetParamsV1): Promise<SessionScopedServicesV1 | null>;
    watch(params: PluginSessionWatchParamsV1, onEvent: (event: PluginSessionWatchEventV1) => void): SubscriptionV1;
}

export type { SessionScopedServicesV1 } from './scoped';
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
