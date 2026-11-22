const listeners = new Set<() => void>();
let motionPending = false;
let presentedHomes = 0;

export function isHomeArrivalMotionPending(): boolean {
    return motionPending;
}

/** The destination has committed its ready content and the Home build (or its Still path) settled. */
export function isHomeArrivalSettled(): boolean {
    return !motionPending && presentedHomes > 0;
}

function publishIfChanged(previous: boolean): void {
    if (previous === isHomeArrivalSettled()) return;
    for (const listener of listeners) listener();
}

export function setHomeArrivalMotionPending(pending: boolean): void {
    const previous = isHomeArrivalSettled();
    motionPending = pending;
    publishIfChanged(previous);
}

/** Keeps readiness scoped to the lifetime of the focused, successfully presented Home. */
export function presentReadyHome(): () => void {
    const previous = isHomeArrivalSettled();
    presentedHomes++;
    publishIfChanged(previous);
    return () => {
        const previous = isHomeArrivalSettled();
        presentedHomes--;
        publishIfChanged(previous);
    };
}

export function subscribeHomeArrival(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
