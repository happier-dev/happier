/**
 * Awaits one unit of follow listener work under caller/invocation cancellation.
 * Acknowledgement belongs to actual listener settlement; only the containing
 * stream's cancellation can supersede that wait.
 */
export async function settleFollowListener(
    work: Promise<void>,
    signal?: AbortSignal,
): Promise<void> {
    let onAbort: (() => void) | undefined;
    try {
        await Promise.race([
            work,
            ...(signal
                ? [new Promise<never>((_, reject) => {
                    onAbort = () => reject(new Error('plugin_operation_aborted'));
                    if (signal.aborted) onAbort();
                    else signal.addEventListener('abort', onAbort, { once: true });
                })]
                : []),
        ]);
    } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}
