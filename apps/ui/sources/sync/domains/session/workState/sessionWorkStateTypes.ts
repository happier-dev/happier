export type SessionWorkStateStatus = 'pending' | 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown';
export type SessionWorkStateStatusReason = 'budgetLimited';
export type SessionWorkStateKind = 'goal' | 'task' | 'todo';
export type SessionWorkStateOrigin = 'vendor' | 'happier' | 'derived';

export type SessionWorkStateItem = Readonly<{
    id: string;
    kind: SessionWorkStateKind;
    origin: SessionWorkStateOrigin;
    status: SessionWorkStateStatus;
    statusReason?: SessionWorkStateStatusReason;
    title: string;
    summary?: string;
    backendId?: string;
    agentId?: string;
    vendorRef?: string;
    order?: number;
    priority?: string;
    tokenBudget?: number | null;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    createdAt?: number;
    startedAt?: number;
    completedAt?: number;
    updatedAt: number;
}>;

export type SessionWorkStateSnapshot = Readonly<{
    v: 1;
    backendId: string;
    agentId?: string;
    updatedAt: number;
    items: readonly SessionWorkStateItem[];
    primaryItemId?: string | null;
    truncated?: Readonly<{
        reason: 'item_limit' | 'provider_limit';
        omittedCount?: number;
    }>;
}>;
