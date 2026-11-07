import type {
    PlanChecklistExecutionState,
    PlanChecklistItem,
    PlanChecklistPhase,
} from '@happier-dev/plugin-ui/components';

export type {
    PlanChecklistPhase,
    PlanChecklistItemStatus,
    PlanChecklistKind,
    PlanChecklistVariant,
    PlanChecklistLogEntry,
    PlanChecklistExecutionError,
    PlanChecklistExecutionState,
    PlanChecklistItem,
} from '@happier-dev/plugin-ui/components';

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
        selectedIds: readonly string[],
    ) => Partial<Record<string, PlanChecklistExecutionState>>;
    onCancelExecution?: () => void;
}>;

export type PlanChecklistControllerResult<Snapshot = unknown> = Readonly<{
    phase: PlanChecklistPhase;
    selectedIds: readonly string[];
    expandedIds: readonly string[];
    executionById: Readonly<Record<string, PlanChecklistExecutionState>>;
    executionError: string | null;
    canContinue: boolean;
    toggleItem: (itemId: string) => void;
    toggleExpanded: (itemId: string) => void;
    publishSnapshot: (snapshot: Snapshot) => void;
    continue: () => Promise<void>;
    retry: () => Promise<void>;
    cancel: () => void;
    resetToSelect: () => void;
}>;
