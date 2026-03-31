import * as React from 'react';

export type PlanChecklistPhase = 'select' | 'execute';

export type PlanChecklistItemStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';

export type PlanChecklistLogEntry = Readonly<{
    ts: number;
    level: 'info' | 'warn' | 'error';
    message: string;
}>;

export type PlanChecklistExecutionError = Readonly<{
    title: string;
    message?: string;
    raw?: unknown;
}>;

export type PlanChecklistExecutionState = Readonly<{
    status: PlanChecklistItemStatus;
    logs: readonly PlanChecklistLogEntry[];
    error?: PlanChecklistExecutionError;
}>;

export type PlanChecklistItem = Readonly<{
    id: string;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    satisfied: boolean;
    disabled: boolean;
    defaultSelected?: boolean;
    selected?: boolean;
    badge?: React.ReactNode;
    renderDetails?: () => React.ReactNode;
    details?: React.ReactNode | (() => React.ReactNode);
}>;

export type PlanChecklistControllerPublishSnapshot<Snapshot> = (snapshot: Snapshot) => void;

export type PlanChecklistControllerOptions<Plan, Snapshot> = Readonly<{
    items: readonly PlanChecklistItem[];
    initialSelectedIds?: readonly string[];
    initialExpandedIds?: readonly string[];
    initialPhase?: PlanChecklistPhase;
    /**
     * Optional hook to enforce selection dependencies (e.g. “if A is deselected, also deselect B”).
     * Runs after internal normalization and before execution starts.
     */
    normalizeSelectedIds?: (selectedIds: readonly string[], items: readonly PlanChecklistItem[]) => readonly string[];
    buildExecutionPlan: (selectedIds: readonly string[]) => Plan;
    runExecutionPlan: (
        plan: Plan,
        publishSnapshot: PlanChecklistControllerPublishSnapshot<Snapshot>,
    ) => Promise<void> | void;
    mapExecutionSnapshotToRowState: (
        snapshot: Snapshot,
        items: readonly PlanChecklistItem[],
    ) => Partial<Record<string, PlanChecklistExecutionState>>;
    onCancelExecution?: () => void;
}>;

export type PlanChecklistControllerResult = Readonly<{
    phase: PlanChecklistPhase;
    selectedIds: readonly string[];
    expandedIds: readonly string[];
    executionById: Readonly<Record<string, PlanChecklistExecutionState>>;
    executionError: string | null;
    canContinue: boolean;
    toggleItem: (itemId: string) => void;
    toggleExpanded: (itemId: string) => void;
    continue: () => Promise<void>;
    retry: () => Promise<void>;
    cancel: () => void;
}>;
