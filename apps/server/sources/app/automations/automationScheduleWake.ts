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

const replyHandoffListeners = new Set<AutomationScheduleWakeListener>();

/** Committed ready/retry rows wake the worker in the API process that wrote them. */
export function emitAutomationReplyHandoffWake(): void {
    for (const listener of replyHandoffListeners) listener();
}

export function subscribeAutomationReplyHandoffWake(listener: AutomationScheduleWakeListener): () => void {
    replyHandoffListeners.add(listener);
    return () => replyHandoffListeners.delete(listener);
}
