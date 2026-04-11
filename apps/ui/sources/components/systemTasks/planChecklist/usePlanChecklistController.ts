import * as React from 'react';

import type {
    PlanChecklistControllerOptions,
    PlanChecklistControllerResult,
    PlanChecklistExecutionState,
    PlanChecklistItem,
    PlanChecklistPhase,
} from './types';

function flattenItems(items: readonly PlanChecklistItem[]): readonly PlanChecklistItem[] {
    const flattened: PlanChecklistItem[] = [];
    for (const item of items) {
        flattened.push(item);
        if (item.children && item.children.length > 0) {
            flattened.push(...flattenItems(item.children));
        }
    }
    return flattened;
}

function findItemById(items: readonly PlanChecklistItem[], itemId: string): PlanChecklistItem | null {
    for (const item of items) {
        if (item.id === itemId) {
            return item;
        }
        if (item.children && item.children.length > 0) {
            const child = findItemById(item.children, itemId);
            if (child) {
                return child;
            }
        }
    }
    return null;
}

function normalizeIds(items: readonly PlanChecklistItem[], ids: readonly string[] | null | undefined): readonly string[] {
    if (!ids || ids.length === 0) {
        return [];
    }
    const flattenedItems = flattenItems(items);
    const validIds = new Set(flattenedItems.map((item) => item.id));
    const selectedIds = new Set(ids);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const item of flattenedItems) {
        if (!validIds.has(item.id)) {
            continue;
        }
        if (selectedIds.has(item.id) && !seen.has(item.id)) {
            seen.add(item.id);
            ordered.push(item.id);
        }
    }
    return ordered;
}

function buildDefaultSelectedIds(items: readonly PlanChecklistItem[]): readonly string[] {
    return flattenItems(items)
        .filter((item) => !item.children?.length)
        .filter((item) => item.defaultSelected ?? item.selected ?? false)
        .map((item) => item.id);
}

function buildInitialSelection(items: readonly PlanChecklistItem[], initialSelectedIds?: readonly string[]): readonly string[] {
    if (initialSelectedIds !== undefined) {
        return normalizeIds(items, initialSelectedIds);
    }
    return buildDefaultSelectedIds(items);
}

function buildInitialExpandedIds(items: readonly PlanChecklistItem[], initialExpandedIds?: readonly string[]): readonly string[] {
    return normalizeIds(items, initialExpandedIds);
}

function mergeExecutionState(
    current: Readonly<Record<string, PlanChecklistExecutionState>>,
    update: Partial<Record<string, PlanChecklistExecutionState>>,
): Readonly<Record<string, PlanChecklistExecutionState>> {
    const next: Record<string, PlanChecklistExecutionState> = { ...current };
    for (const [itemId, state] of Object.entries(update)) {
        if (!state) {
            continue;
        }
        const previous = next[itemId];
        next[itemId] = {
            status: state.status ?? previous?.status ?? 'idle',
            logs: state.logs ?? previous?.logs ?? [],
            error: state.error ?? previous?.error,
        };
    }
    return next;
}

function buildQueuedExecutionState(
    items: readonly PlanChecklistItem[],
    selectedIds: readonly string[],
): Readonly<Record<string, PlanChecklistExecutionState>> {
    const selectedSet = new Set(selectedIds);
    const result: Record<string, PlanChecklistExecutionState> = {};
    for (const item of flattenItems(items)) {
        const selected = selectedSet.has(item.id);
        result[item.id] = {
            status: item.satisfied ? 'done' : (selected ? 'queued' : 'idle'),
            logs: [],
        };
    }
    return result;
}

export function usePlanChecklistController<Plan, Snapshot>(
    options: PlanChecklistControllerOptions<Plan, Snapshot>,
): PlanChecklistControllerResult<Snapshot> {
    const {
        items,
        initialExpandedIds,
        initialPhase,
        initialSelectedIds,
        normalizeSelectedIds,
        buildExecutionPlan,
        runExecutionPlan,
        mapExecutionSnapshotToRowState,
        onCancelExecution,
    } = options;
    const selectionTouchedRef = React.useRef(false);
    const [phase, setPhase] = React.useState<PlanChecklistPhase>(initialPhase ?? 'select');
    const [selectedIds, setSelectedIds] = React.useState<readonly string[]>(() => buildInitialSelection(items, initialSelectedIds));
    const selectedIdsRef = React.useRef(selectedIds);
    const [expandedIds, setExpandedIds] = React.useState<readonly string[]>(() => buildInitialExpandedIds(items, initialExpandedIds));
    const [executionById, setExecutionById] = React.useState<Readonly<Record<string, PlanChecklistExecutionState>>>({});
    const [executionError, setExecutionError] = React.useState<string | null>(null);

    React.useEffect(() => {
        selectedIdsRef.current = selectedIds;
    }, [selectedIds]);

    React.useEffect(() => {
        setSelectedIds((current) => {
            const normalized = normalizeIds(items, current);
            if (normalized.length > 0) {
                return normalized;
            }
            return selectionTouchedRef.current ? normalized : buildDefaultSelectedIds(items);
        });
        setExpandedIds((current) => normalizeIds(items, current));
    }, [items]);

    const canContinue = selectedIds.length > 0;

    const toggleItem = React.useCallback((itemId: string) => {
        if (phase !== 'select') {
            return;
        }
        const item = findItemById(items, itemId);
        if (!item || item.disabled) {
            return;
        }

        selectionTouchedRef.current = true;
        setSelectedIds((current) => {
            if (current.includes(itemId)) {
                const next = current.filter((candidate) => candidate !== itemId);
                const normalized = normalizeIds(items, next);
                return normalizeSelectedIds ? normalizeIds(items, normalizeSelectedIds(normalized, items)) : normalized;
            }
            const normalized = normalizeIds(items, [...current, itemId]);
            return normalizeSelectedIds ? normalizeIds(items, normalizeSelectedIds(normalized, items)) : normalized;
        });
    }, [items, normalizeSelectedIds, phase]);

    const toggleExpanded = React.useCallback((itemId: string) => {
        setExpandedIds((current) => {
            if (current.includes(itemId)) {
                return current.filter((candidate) => candidate !== itemId);
            }
            return normalizeIds(items, [...current, itemId]);
        });
    }, [items]);

    const publishSnapshot = React.useCallback((snapshot: Snapshot) => {
        const update = mapExecutionSnapshotToRowState(snapshot, items, selectedIdsRef.current);
        setExecutionById((current) => mergeExecutionState(current, update));
    }, [items, mapExecutionSnapshotToRowState]);

    const continueExecution = React.useCallback(async () => {
        const normalizedSelectedIds = (() => {
            const base = normalizeIds(items, selectedIds);
            if (!normalizeSelectedIds) return base;
            return normalizeIds(items, normalizeSelectedIds(base, items));
        })();
        setSelectedIds(normalizedSelectedIds);
        setExecutionError(null);
        setPhase('execute');
        setExecutionById(buildQueuedExecutionState(items, normalizedSelectedIds));

        try {
            const executionPlan = buildExecutionPlan(normalizedSelectedIds);
            await runExecutionPlan(executionPlan, publishSnapshot);
        } catch (error) {
            setExecutionError(error instanceof Error ? error.message : 'plan_checklist_execution_failed');
            throw error;
        }
    }, [buildExecutionPlan, items, normalizeSelectedIds, publishSnapshot, runExecutionPlan, selectedIds]);

    const retry = React.useCallback(async () => {
        await continueExecution();
    }, [continueExecution]);

    const cancel = React.useCallback(() => {
        onCancelExecution?.();
    }, [onCancelExecution]);

    const resetToSelect = React.useCallback(() => {
        setExecutionById({});
        setExecutionError(null);
        setPhase('select');
    }, []);

    return {
        phase,
        selectedIds,
        expandedIds,
        executionById,
        executionError,
        canContinue,
        toggleItem,
        toggleExpanded,
        publishSnapshot,
        continue: continueExecution,
        retry,
        cancel,
        resetToSelect,
    };
}
