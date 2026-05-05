import type {
    SessionId,
    SubagentId,
    SubagentLifecycleDetailV1,
    SubagentRefInputV1,
    SubagentRefV1,
    SubagentStatusV1,
} from '@happier-dev/protocol';

import type { SubscriptionV1 } from '../context';

export type SubagentListParamsV1 = Readonly<{
    parentSessionId?: SessionId;
    groupId?: string | null;
}>;

export type SubagentGetParamsV1 = Readonly<{
    id: SubagentId;
    parentSessionId?: SessionId;
}>;

export type SubagentWatchParamsV1 = Readonly<{
    parentSessionId?: SessionId;
    id?: SubagentId;
}>;

export type SubagentWatchEventV1 = Readonly<{
    kind: 'snapshot' | 'changed' | 'removed';
    subagents?: readonly SubagentRefV1[];
    subagent?: SubagentRefV1;
    id?: SubagentId;
}>;

export type SubagentStatusUpdateParamsV1 = Readonly<{
    id: SubagentId;
    parentSessionId?: SessionId;
    status: SubagentStatusV1;
    lifecycleDetail?: SubagentLifecycleDetailV1;
    completedAt?: number;
}>;

export type SubagentCompleteParamsV1 = Readonly<{
    id: SubagentId;
    parentSessionId?: SessionId;
    status?: Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
    lifecycleDetail?: SubagentLifecycleDetailV1;
    completedAt?: number;
}>;

export interface PluginSubagentsServiceV1 {
    list(params?: SubagentListParamsV1): Promise<readonly SubagentRefV1[]>;
    get(params: SubagentGetParamsV1): Promise<SubagentRefV1 | null>;
    watch(params: SubagentWatchParamsV1, onEvent: (event: SubagentWatchEventV1) => void): SubscriptionV1;
    upsert(input: SubagentRefInputV1): Promise<SubagentRefV1>;
    updateStatus(params: SubagentStatusUpdateParamsV1): Promise<SubagentRefV1>;
    complete(params: SubagentCompleteParamsV1): Promise<SubagentRefV1>;
}

export type {
    SubagentLifecycleDetailV1,
    SubagentRefInputV1,
    SubagentRefV1,
    SubagentStatusV1,
};
