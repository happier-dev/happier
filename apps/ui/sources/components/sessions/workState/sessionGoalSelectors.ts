import type {
    SessionWorkStateItem,
    SessionWorkStateSnapshot,
} from '@/sync/domains/session/workState/sessionWorkStateTypes';

/**
 * Pure goal selectors for the goal controller (G6). Extracted from the React hook so goal selection
 * is testable without rendering the popover and so the controller no longer carries a private
 * `findGoal()` that could diverge (D-2 split-brain: first-match `findGoal` vs the ranked editable
 * goal). Ported from remote-dev by intent, adapted to dev's `@/sync/domains/...` type paths.
 */

const EDITABLE_GOAL_ACTIVE_STATUS_SCORE: Readonly<Record<string, number>> = {
    active: 0,
    pending: 1,
    paused: 2,
    blocked: 3,
    unknown: 4,
    complete: 5,
    cancelled: 6,
};

function rankEditableGoalItem(
    snapshot: SessionWorkStateSnapshot,
    item: SessionWorkStateItem,
): readonly [number, number, number, number] {
    return [
        snapshot.primaryItemId === item.id ? 0 : 1,
        item.backendId === snapshot.backendId ? 0 : 1,
        EDITABLE_GOAL_ACTIVE_STATUS_SCORE[item.status] ?? EDITABLE_GOAL_ACTIVE_STATUS_SCORE.unknown,
        -item.updatedAt,
    ];
}

function compareEditableGoalItems(
    snapshot: SessionWorkStateSnapshot,
    left: SessionWorkStateItem,
    right: SessionWorkStateItem,
): number {
    const leftRank = rankEditableGoalItem(snapshot, left);
    const rightRank = rankEditableGoalItem(snapshot, right);
    for (let index = 0; index < leftRank.length; index += 1) {
        const diff = leftRank[index] - rightRank[index];
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * The goal item the controls EDIT. The edit form can re-activate a completed/cleared goal, so
 * editing targets the canonical goal row, not only the active-only "current" goal used for labels.
 * Merged work-state snapshots can preserve multiple provider goal rows, so this selector must not
 * depend on array order (D-2 fix — replaces first-match `findGoal`).
 */
export function resolveEditableGoalItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    const goals = snapshot?.items.filter((item) => item.kind === 'goal') ?? [];
    if (!snapshot || goals.length === 0) return null;
    return [...goals].sort((left, right) => compareEditableGoalItems(snapshot, left, right))[0] ?? null;
}

/**
 * The session's CURRENT goal (active-only) for "current goal" surfaces such as the chip label. Kept
 * as a single predicate so the controller and label surfaces agree on what "current" means.
 */
export function resolveCurrentGoalItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    return snapshot?.items.find((item) => item.kind === 'goal' && item.status === 'active') ?? null;
}

/** Whether the explicit goal-chip creation surface should render. */
export function resolveGoalCreationControlsVisible(args: Readonly<{
    editableGoal: boolean;
}>): boolean {
    return args.editableGoal;
}

/** Whether the status/work-state popover should render goal management controls. */
export function resolveGoalManagementControlsVisible(args: Readonly<{
    editableGoal: boolean;
    snapshot: SessionWorkStateSnapshot | null;
}>): boolean {
    return args.editableGoal && Boolean(resolveEditableGoalItem(args.snapshot));
}

/**
 * Return the snapshot with the goal row removed, so the popover task list renders only the non-goal
 * (task/todo) items while the goal controls own the goal. Preserves referential identity when there
 * is nothing to omit. Clears `primaryItemId` only when it pointed at the omitted goal.
 */
export function omitGoalItemFromSnapshot(
    snapshot: SessionWorkStateSnapshot | null,
    goalId: string | null,
): SessionWorkStateSnapshot | null {
    if (!snapshot || !goalId) return snapshot;
    if (!snapshot.items.some((item) => item.id === goalId)) return snapshot;
    return {
        ...snapshot,
        primaryItemId: snapshot.primaryItemId === goalId ? null : snapshot.primaryItemId,
        items: snapshot.items.filter((item) => item.id !== goalId),
    };
}
