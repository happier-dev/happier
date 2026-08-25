/**
 * The one bound on how long any External Sessions follow owner waits for an
 * author-supplied listener to settle.
 *
 * Listener code is trusted but ordinary: it can throw, hang, or never settle.
 * Whichever transport carries the follow, the owner that awaits that callback
 * before acknowledging delivery has to stop waiting at the same ceiling, or a
 * single non-settling callback wedges the lifecycle above it.
 */
export const EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS = 5_000;

/**
 * Awaits one unit of follow listener work under that ceiling and under caller
 * or invocation cancellation.
 *
 * The abandoned work keeps running inside the author's callback; its eventual
 * settlement is deliberately ignored rather than allowed to advance delivery.
 * `Promise.race` has already subscribed to it, so a late rejection is delivered
 * to this settled race and cannot surface as an unhandled rejection.
 */
export async function settleFollowListenerBounded(
    work: Promise<void>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('plugin_external_follow_listener_deadline_exceeded')),
                    timeoutMs,
                );
                timer.unref?.();
            }),
            ...(signal
                ? [new Promise<never>((_, reject) => {
                    onAbort = () => reject(new Error('plugin_operation_aborted'));
                    if (signal.aborted) onAbort();
                    else signal.addEventListener('abort', onAbort, { once: true });
                })]
                : []),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}
