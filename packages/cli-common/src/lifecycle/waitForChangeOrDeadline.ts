import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';

export type WaitForChangeOutcome = 'changed' | 'deadline' | 'aborted';

/** Wait once; the caller observes its authoritative state after a change or deadline. */
export async function waitForChangeOrDeadline(input: Readonly<{
    waitForChange(signal: AbortSignal): Promise<void>;
    signal?: AbortSignal;
    remainingMs?: number;
    unref?: true;
}>): Promise<WaitForChangeOutcome> {
    if (input.signal?.aborted) return 'aborted';
    const waiting = new AbortController();
    let cancelDeadline: (() => void) | undefined;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<WaitForChangeOutcome>(resolve => {
        onAbort = () => { resolve('aborted'); waiting.abort(input.signal?.reason); };
        input.signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const deadline = new Promise<WaitForChangeOutcome>(resolve => {
            if (input.remainingMs !== undefined) {
                // Node's timer boundary only slices the wait; it never shortens the selected lifetime.
                cancelDeadline = armDeadlineTimer(Date.now() + Math.min(input.remainingMs, 2_147_483_647),
                    () => resolve('deadline'), input.unref ? { unref: true } : {});
            }
        });
        const changed = input.waitForChange(waiting.signal).then((): WaitForChangeOutcome => 'changed');
        const result = await Promise.race([cancelled, changed, deadline]);
        return input.signal?.aborted ? 'aborted' : result;
    } catch (error) {
        if (input.signal?.aborted) return 'aborted';
        throw error;
    } finally {
        cancelDeadline?.();
        waiting.abort();
        input.signal?.removeEventListener('abort', onAbort);
    }
}
