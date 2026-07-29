export type SessionWorkStateStatus = 'pending' | 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown';
export type SessionWorkStateStatusReason = 'blocked' | 'usageLimited' | 'budgetLimited' | 'interrupted';
export type SessionWorkStateKind = 'goal' | 'task' | 'todo';
export type SessionWorkStateOrigin = 'vendor' | 'happier' | 'derived';

// Provider-derived goal capabilities (mirrors protocol `SessionWorkStateGoalCapabilitiesV1`). The
// owning provider publishes these; the UI gates goal actions on them instead of branching on
// provider id (Claude exposes edit/clear only; absent capabilities = legacy full control).
export type SessionWorkStateGoalCapabilities = Readonly<{
    canEdit?: boolean;
    canStop?: boolean;
    canClear?: boolean;
}>;

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
    goalCapabilities?: SessionWorkStateGoalCapabilities;
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
