type MergedAbortSignals = Readonly<{
    signal: AbortSignal | undefined;
    dispose(): void;
}>;

type RequiredMergedAbortSignals = Readonly<{
    signal: AbortSignal;
    dispose(): void;
}>;

// Keep cross-platform abort throwing owned by the public async boundary used
// by both host UI and plugin code. This module owns only signal composition.
export { throwIfAborted } from '@happier-dev/plugin-sdk/async';

function readAbortReason(signal: AbortSignal): unknown {
    return 'reason' in signal ? signal.reason : undefined;
}

function abortWithSourceReason(controller: AbortController, source: AbortSignal): void {
    const reason = readAbortReason(source);
    if (reason === undefined) controller.abort();
    else controller.abort(reason);
}

/**
 * Creates one cancellation signal for the supplied UI lifetimes without relying
 * on the browser-only `AbortSignal.any` static helper.
 */
export function mergeAbortSignals(signals: readonly []): MergedAbortSignals;
export function mergeAbortSignals(
    signals: readonly [AbortSignal, ...(AbortSignal | undefined)[]],
): RequiredMergedAbortSignals;
export function mergeAbortSignals(
    signals: ReadonlyArray<AbortSignal | undefined>,
): MergedAbortSignals;
export function mergeAbortSignals(
    signals: ReadonlyArray<AbortSignal | undefined>,
): MergedAbortSignals {
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (activeSignals.length === 0) {
        return Object.freeze({ signal: undefined, dispose: () => {} });
    }
    if (activeSignals.length === 1) {
        return Object.freeze({ signal: activeSignals[0], dispose: () => {} });
    }

    const controller = new AbortController();
    const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = [];
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const { signal, listener } of listeners) {
            try {
                signal.removeEventListener('abort', listener);
            } catch {
                // A non-standard source signal cannot prevent other listeners from cleaning up.
            }
        }
    };
    const abortMerged = (source: AbortSignal) => {
        if (controller.signal.aborted) return;
        try {
            abortWithSourceReason(controller, source);
        } finally {
            dispose();
        }
    };

    for (const signal of activeSignals) {
        if (signal.aborted) {
            abortMerged(signal);
            break;
        }
        const listener = () => abortMerged(signal);
        listeners.push({ signal, listener });
        signal.addEventListener('abort', listener, { once: true });
        // An abort may happen between the initial check and listener registration.
        if (signal.aborted) {
            abortMerged(signal);
            break;
        }
    }

    return Object.freeze({ signal: controller.signal, dispose });
}
