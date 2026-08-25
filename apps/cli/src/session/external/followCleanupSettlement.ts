/**
 * One physical External Sessions follow subscription, one cleanup invocation at
 * a time.
 *
 * Every follow owner that holds a physical subscription has the same cleanup
 * contract, so it lives here once instead of being re-derived per owner:
 *
 * - a caller that arrives while the disposer is still running joins that
 *   invocation instead of disposing the same handle a second time;
 * - cleanup that failed is cleanup that still has to happen, and cleanup that
 *   has not settled by the ceiling has not happened at all — neither is
 *   reported as disposal, so the owner keeps custody of the exact handle;
 * - a settled rejection is released to the caller that observes it, so the next
 *   caller retries the exact same handle; an unsettled one is retained so the
 *   next caller joins it and still sees its eventual failure.
 *
 * Whether a given caller must be told about that failure is the owner's
 * decision, not this module's: an explicit caller disposal owns the outcome,
 * while owner-driven retirement is a bounded lifecycle fence.
 */

const EXTERNAL_SESSION_FOLLOW_CLEANUP_DEADLINE_MESSAGE =
    'plugin_external_follow_cleanup_deadline_exceeded';

/**
 * Distinguishes "the disposer has not answered yet" from "the disposer failed".
 * A plugin disposer can reject with any message, so the ceiling is recognized
 * by identity rather than by text.
 */
class ExternalSessionFollowCleanupDeadlineError extends Error {
    constructor() {
        super(EXTERNAL_SESSION_FOLLOW_CLEANUP_DEADLINE_MESSAGE);
        this.name = 'ExternalSessionFollowCleanupDeadlineError';
    }
}

export function isExternalSessionFollowCleanupDeadline(
    error: unknown,
): boolean {
    return error instanceof ExternalSessionFollowCleanupDeadlineError;
}

export type ExternalSessionFollowCleanupCustody = Readonly<{
    /**
     * Runs the physical disposer, or joins the one already in flight, and waits
     * for it under this custody's ceiling. Resolves only when cleanup actually
     * completed; rejects with the disposer's own failure, or with the ceiling
     * deadline while it is still unsettled.
     */
    settle(dispose: () => void | Promise<void>): Promise<void>;
}>;

export function createExternalSessionFollowCleanupCustody(
    timeoutMs: number,
): ExternalSessionFollowCleanupCustody {
    let invocation: Promise<void> | null = null;
    let invocationSettled = false;
    return Object.freeze({
        async settle(dispose: () => void | Promise<void>): Promise<void> {
            if (!invocation) {
                invocationSettled = false;
                invocation = Promise.resolve()
                    .then(dispose)
                    .finally(() => { invocationSettled = true; });
            }
            const attempt = invocation;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                // The ceiling below can abandon this invocation while the
                // provider is still inside it. The race subscribes to it here,
                // so a rejection it reports after being abandoned reaches this
                // settled race rather than the process, and is re-read by
                // whichever caller retries next.
                await Promise.race([
                    attempt,
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(
                                new ExternalSessionFollowCleanupDeadlineError(),
                            ),
                            timeoutMs,
                        );
                        timer.unref?.();
                    }),
                ]);
            } catch (error) {
                if (invocationSettled && invocation === attempt) {
                    invocation = null;
                }
                throw error;
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
        },
    });
}
