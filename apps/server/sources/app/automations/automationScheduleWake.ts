type AutomationScheduleWakeListener = () => void;

const listeners = new Set<AutomationScheduleWakeListener>();

/** Content-free process-local hint; indexed trigger rows remain durable truth. */
export function emitAutomationScheduleWake(): void {
    for (const listener of listeners) listener();
}

export function subscribeAutomationScheduleWake(listener: AutomationScheduleWakeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
