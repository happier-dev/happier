/** Timer chunks represent the platform's signed-32 delay, never the caller's deadline. */
export function armDeadlineTimer(
    deadlineAtMs: number,
    onDeadline: () => void,
    options: Readonly<{ unref?: true }> = {},
): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const arm = (): void => {
        timer = setTimeout(() => {
            if (disposed) return;
            if (Date.now() < deadlineAtMs) {
                arm();
                return;
            }
            disposed = true;
            onDeadline();
        }, Math.min(2_147_483_647, Math.max(0, deadlineAtMs - Date.now())));
        // Browser and native UI timers return numbers; Node timers may be unreferenced.
        if (options.unref && typeof timer === 'object' && timer !== null
            && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
    };
    arm();
    return () => {
        disposed = true;
        clearTimeout(timer);
    };
}
