import * as React from 'react';

import type {
    PlanChecklistControllerOptions,
    PlanChecklistControllerResult,
    PlanChecklistExecutionState,
    PlanChecklistItem,
    PlanChecklistPhase,
} from './types';

function normalizeIds(items: readonly PlanChecklistItem[], ids: readonly string[] | null | undefined): readonly string[] {
    if (!ids || ids.length === 0) {
        return [];
    }
    const validIds = new Set(items.map((item) => item.id));
    const selectedIds = new Set(ids);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const item of items) {
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
    return items.filter((item) => item.defaultSelected ?? item.selected ?? false).map((item) => item.id);
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
    for (const item of items) {
        const selected = selectedSet.has(item.id);
        result[item.id] = {
            status: (item.satisfied && item.disabled) ? 'done' : (selected ? 'queued' : 'idle'),
            logs: [],
        };
    }
    return result;
}

export function usePlanChecklistController<Plan, Snapshot>(
    options: PlanChecklistControllerOptions<Plan, Snapshot>,
): PlanChecklistControllerResult {
    const selectionTouchedRef = React.useRef(false);
    const [phase, setPhase] = React.useState<PlanChecklistPhase>(options.initialPhase ?? 'select');
    const [selectedIds, setSelectedIds] = React.useState<readonly string[]>(() => buildInitialSelection(options.items, options.initialSelectedIds));
    const [expandedIds, setExpandedIds] = React.useState<readonly string[]>(() => buildInitialExpandedIds(options.items, options.initialExpandedIds));
    const [executionById, setExecutionById] = React.useState<Readonly<Record<string, PlanChecklistExecutionState>>>({});
    const [executionError, setExecutionError] = React.useState<string | null>(null);

    React.useEffect(() => {
        setSelectedIds((current) => {
            const normalized = normalizeIds(options.items, current);
            if (normalized.length > 0) {
                return normalized;
            }
            return selectionTouchedRef.current ? normalized : buildDefaultSelectedIds(options.items);
        });
        setExpandedIds((current) => normalizeIds(options.items, current));
    }, [options.items]);

    const canContinue = selectedIds.length > 0;

    const toggleItem = React.useCallback((itemId: string) => {
        if (phase !== 'select') {
            return;
        }
        const item = options.items.find((candidate) => candidate.id === itemId);
        if (!item || item.disabled) {
            return;
        }

        selectionTouchedRef.current = true;
        setSelectedIds((current) => {
            if (current.includes(itemId)) {
                const next = current.filter((candidate) => candidate !== itemId);
                const normalized = normalizeIds(options.items, next);
                return options.normalizeSelectedIds ? normalizeIds(options.items, options.normalizeSelectedIds(normalized, options.items)) : normalized;
            }
            const normalized = normalizeIds(options.items, [...current, itemId]);
            return options.normalizeSelectedIds ? normalizeIds(options.items, options.normalizeSelectedIds(normalized, options.items)) : normalized;
        });
    }, [options.items, phase]);

    const toggleExpanded = React.useCallback((itemId: string) => {
        setExpandedIds((current) => {
            if (current.includes(itemId)) {
                return current.filter((candidate) => candidate !== itemId);
            }
            return normalizeIds(options.items, [...current, itemId]);
        });
    }, [options.items]);

    const publishSnapshot = React.useCallback((snapshot: Snapshot) => {
        const update = options.mapExecutionSnapshotToRowState(snapshot, options.items);
        setExecutionById((current) => mergeExecutionState(current, update));
    }, [options]);

    const continueExecution = React.useCallback(async () => {
        const normalizedSelectedIds = (() => {
            const base = normalizeIds(options.items, selectedIds);
            if (!options.normalizeSelectedIds) return base;
            return normalizeIds(options.items, options.normalizeSelectedIds(base, options.items));
        })();
        setExecutionError(null);
        setPhase('execute');
        setExecutionById(buildQueuedExecutionState(options.items, normalizedSelectedIds));

        try {
            const executionPlan = options.buildExecutionPlan(normalizedSelectedIds);
            await options.runExecutionPlan(executionPlan, publishSnapshot);
        } catch (error) {
            setExecutionError(error instanceof Error ? error.message : 'plan_checklist_execution_failed');
            throw error;
        }
    }, [options, publishSnapshot, selectedIds]);

    const retry = React.useCallback(async () => {
        await continueExecution();
    }, [continueExecution]);

    const cancel = React.useCallback(() => {
        options.onCancelExecution?.();
    }, [options]);

    return {
        phase,
        selectedIds,
        expandedIds,
        executionById,
        executionError,
        canContinue,
        toggleItem,
        toggleExpanded,
        continue: continueExecution,
        retry,
        cancel,
    };
}
