export type ClaudeRunnerLoopSettlement<T> =
    | Readonly<{ kind: 'completed'; value: T }>
    | Readonly<{ kind: 'failed'; error: unknown }>
    | Readonly<{ kind: 'terminated' }>;

/**
 * Settles the Claude provider loop for the runner's post-loop path.
 *
 * Once runner termination is requested, its `onTerminate` owns teardown and the process exit with
 * the termination outcome's code. Termination aborts the loop, so the loop settling is not a normal
 * exit: the runner must not run its own teardown or exit as well. `terminated` is returned only
 * after the termination owner has finished (and called exit). Normal cleanup remains inside
 * this settlement so termination arriving during its asynchronous work retains exit ownership.
 */
export async function settleClaudeRunnerLoop<T>(
    loop: Promise<T>,
    termination: Readonly<{ isRequested: () => boolean; whenTerminated: Promise<unknown> }>,
    cleanupAfterLoop?: () => Promise<void>,
): Promise<ClaudeRunnerLoopSettlement<T>> {
    let settlement: ClaudeRunnerLoopSettlement<T>;
    try {
        settlement = { kind: 'completed', value: await loop };
    } catch (error) {
        settlement = { kind: 'failed', error };
    }
    if (!termination.isRequested()) {
        try {
            await cleanupAfterLoop?.();
        } catch (error) {
            if (!termination.isRequested()) throw error;
        }
    }
    if (!termination.isRequested()) {
        return settlement;
    }
    await termination.whenTerminated;
    return { kind: 'terminated' };
}
