import { isRecentActivityCompletion } from '@/activity/attention/activityCompletionTiming';

export { ACTIVITY_COMPLETION_RECENCY_WINDOW_MS as COMPLETION_QUEUE_RECENCY_WINDOW_MS } from '@/activity/attention/activityCompletionTiming';

export type CompletionQueueVariant = 'turn_complete' | 'subagent_done' | 'pending_tool';

export type CompletionQueueItem = Readonly<{
    id: string;
    sessionId: string;
    variant: CompletionQueueVariant;
    occurredAtMs: number;
    sticky: boolean;
}>;

export type CompletionQueueState = Readonly<{
    visible: CompletionQueueItem | null;
    pending: readonly CompletionQueueItem[];
}>;

export type CompletionQueueEvent = Readonly<{
    id: string;
    sessionId: string;
    variant: CompletionQueueVariant;
    occurredAtMs: number;
    nowMs: number;
}>;

export type CompletionQueueAction =
    | Readonly<{ type: 'enqueue'; event: CompletionQueueEvent }>
    | Readonly<{ type: 'dismiss'; id: string }>;

const COMPLETION_QUEUE_PRIORITY: Record<CompletionQueueVariant, number> = {
    pending_tool: 30,
    turn_complete: 20,
    subagent_done: 10,
};

function isRecentCompletionEvent(event: CompletionQueueEvent): boolean {
    return isRecentActivityCompletion(event.occurredAtMs, event.nowMs);
}

function toCompletionQueueItem(event: CompletionQueueEvent): CompletionQueueItem {
    return {
        id: event.id,
        sessionId: event.sessionId,
        variant: event.variant,
        occurredAtMs: event.occurredAtMs,
        sticky: event.variant === 'subagent_done',
    };
}

function compareCompletionQueueItems(left: CompletionQueueItem, right: CompletionQueueItem): number {
    const priorityDelta = COMPLETION_QUEUE_PRIORITY[right.variant] - COMPLETION_QUEUE_PRIORITY[left.variant];
    if (priorityDelta !== 0) return priorityDelta;
    return left.occurredAtMs - right.occurredAtMs;
}

function selectVisible(items: readonly CompletionQueueItem[]): CompletionQueueState {
    const sorted = [...items].sort(compareCompletionQueueItems);
    return {
        visible: sorted[0] ?? null,
        pending: sorted.slice(1),
    };
}

export function createCompletionQueueState(): CompletionQueueState {
    return {
        visible: null,
        pending: [],
    };
}

export function reduceCompletionQueue(
    state: CompletionQueueState,
    action: CompletionQueueAction,
): CompletionQueueState {
    const items = [
        ...(state.visible ? [state.visible] : []),
        ...state.pending,
    ];

    if (action.type === 'dismiss') {
        return selectVisible(items.filter((item) => item.id !== action.id));
    }

    if (!isRecentCompletionEvent(action.event)) {
        return selectVisible(items);
    }

    return selectVisible([
        ...items.filter((item) => item.id !== action.event.id),
        toCompletionQueueItem(action.event),
    ]);
}
