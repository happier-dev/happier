import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';

export type ActivitySurfaceSessionViewModel = Readonly<{
    serverId: string | null;
    serverUrl?: string | null;
    serverName?: string | null;
    sessionId: string;
    title: string;
    subtitle: string | null;
    previewText: string | null;
    statusText: string | null;
    attentionState: SessionActivityAttention['attentionState'];
    route: string;
    target: string;
    defaultTarget: string;
    activityName?: string | null;
    activityInstanceKey?: string | null;
    canExecuteDirectActions?: boolean;
    updatedAt: number;
    isPrimary: boolean;
}>;

export type ActivitySurfaceCountsViewModel = Readonly<{
    attentionCount: number;
    runningCount: number;
    permissionCount: number;
}>;
