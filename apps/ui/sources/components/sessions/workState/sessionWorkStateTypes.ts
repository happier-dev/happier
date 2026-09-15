import type { SessionWorkStateStatusReasonV1 } from '@happier-dev/protocol';

export type SessionWorkStateStatus = 'pending' | 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown';
export type SessionWorkStateStatusReason = SessionWorkStateStatusReasonV1;
export type SessionWorkStateKind = 'goal' | 'task' | 'todo';
export type SessionWorkStateOrigin = 'vendor' | 'happier' | 'derived';

/**
 * Provider-derived capability flags for a `kind:'goal'` item. When the provider source publishes
 * this object the UI gates each goal action by the matching flag (e.g. Claude publishes
 * `{ canEdit, canClear }` and therefore exposes only edit/set + clear). When it is absent the goal
 * is treated as legacy/full-control (Codex), so every action stays visible — back-compat safe.
 */
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
    goalCapabilities?: SessionWorkStateGoalCapabilities;
    title: string;
    summary?: string;
    backendId?: string;
    agentId?: string;
    vendorRef?: string;
    order?: number;
    /**
     * Id of the owning parent item (e.g. a subagent/task under a workflow run). Preserved from the
     * protocol schema so later workflow correlation can group children without re-reading raw
     * metadata (W2).
     */
    parentId?: string;
    priority?: string;
    /** Fractional completion in [0,1] for progress-bearing items (W2). */
    progress?: number;
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
