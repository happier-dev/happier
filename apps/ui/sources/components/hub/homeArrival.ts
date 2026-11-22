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

function publish(): void {
    for (const listener of listeners) listener();
}

export function setHomeArrivalMotionPending(pending: boolean): void {
    if (motionPending === pending) return;
    motionPending = pending;
    publish();
}

/** Keeps readiness scoped to the lifetime of the focused, successfully presented Home. */
export function presentReadyHome(): () => void {
    const previous = isHomeArrivalSettled();
    presentedHomes++;
    if (previous !== isHomeArrivalSettled()) publish();
    return () => {
        const previous = isHomeArrivalSettled();
        presentedHomes--;
        if (previous !== isHomeArrivalSettled()) publish();
    };
}

export function subscribeHomeArrival(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
