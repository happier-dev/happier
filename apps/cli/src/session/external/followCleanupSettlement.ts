/**
 * One physical External Sessions follow subscription, one cleanup invocation at
 * a time.
 *
 * Every follow owner that holds a physical subscription has the same cleanup
 * contract, so it lives here once instead of being re-derived per owner:
 *
 * - a caller that arrives while the disposer is still running joins that
 *   invocation instead of disposing the same handle a second time;
 * - cleanup that failed is cleanup that still has to happen, so the owner
 *   keeps custody of the exact handle;
 * - a settled rejection is released to the caller that observes it, so the next
 *   caller retries the exact same handle; an unsettled one is retained so the
 *   next caller joins it and still sees its eventual failure.
 *
 * Physical cleanup settles only when the disposer answers.
 */

export type ExternalSessionFollowCleanupCustody = Readonly<{
    /**
     * Runs the physical disposer, or joins the one already in flight, and waits
     * for its physical settlement. Rejects with the disposer's own failure.
     */
    settle(dispose: () => void | Promise<void>): Promise<void>;
}>;

export function createExternalSessionFollowCleanupCustody(): ExternalSessionFollowCleanupCustody {
    let invocation: Promise<void> | null = null;
    return Object.freeze({
        async settle(dispose: () => void | Promise<void>): Promise<void> {
            if (!invocation) {
                invocation = Promise.resolve().then(dispose);
            }
            const attempt = invocation;
            try {
                await attempt;
            } catch (error) {
                if (invocation === attempt) {
                    invocation = null;
                }
                throw error;
            }
        },
    });
}
