import type {
    SessionWorkStateItemKindV1,
    SessionWorkStateItemOriginV1,
    SessionWorkStateStatusReasonV1,
    SessionWorkStateStatusV1,
} from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';

export type SessionWorkStateStatus = SessionWorkStateStatusV1;
export type SessionWorkStateStatusReason = SessionWorkStateStatusReasonV1;
export type SessionWorkStateKind = SessionWorkStateItemKindV1;
export type SessionWorkStateOrigin = SessionWorkStateItemOriginV1;

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
