const ESCAPE_EVENT_HANDLED_KEY = '__happierEscapeEventHandled';

export const ESCAPE_KEY_BLOCKER_PRIORITIES = {
    panes: 100,
    bottomPane: 200,
} as const;

type EscapeKeyBlockerEntry = Readonly<{
    id: number;
    priority: number;
}>;

let nextEscapeKeyBlockerId = 1;
let escapeKeyBlockers: ReadonlyArray<EscapeKeyBlockerEntry> = [];

export function markEscapeEventHandled(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    try {
        (event as any)[ESCAPE_EVENT_HANDLED_KEY] = true;
    } catch {
        // ignore readonly/frozen events
    }
}

export function isEscapeEventHandled(event: unknown): boolean {
    if (!event || typeof event !== 'object') return false;
    return (event as any)[ESCAPE_EVENT_HANDLED_KEY] === true;
}

export function getMaxEscapeKeyBlockerPriority(): number {
    let max = 0;
    for (const blocker of escapeKeyBlockers) {
        if (blocker.priority > max) max = blocker.priority;
    }
    return max;
}

export function registerEscapeKeyBlocker(priority: number): () => void {
    const id = nextEscapeKeyBlockerId++;
    const entry: EscapeKeyBlockerEntry = { id, priority };
    escapeKeyBlockers = [...escapeKeyBlockers, entry];

    return () => {
        escapeKeyBlockers = escapeKeyBlockers.filter((b) => b.id !== id);
    };
}
