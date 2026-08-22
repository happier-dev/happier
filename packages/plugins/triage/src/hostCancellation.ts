/**
 * Whether a rejected host call was CANCELLED rather than refused.
 *
 * The distinction is load-bearing wherever a caller turns a rejection into a
 * settled answer: a store or provider refusal is a fact about that boundary and
 * may be reported, while a cancellation means the caller stopped asking and
 * learned nothing. Reporting a cancelled call as a settled outcome invents an
 * answer nobody received.
 *
 * The signal is checked first because a caller that aborted knows it did so
 * regardless of which error shape the boundary happened to reject with, and
 * cancellation reaches this plugin in three shapes: an aborted signal, a
 * `DOMException` named `AbortError`, and a host error carrying `cancelled` or
 * `aborted` as its code.
 */
export function isHostCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
    if (signal?.aborted === true) return true;
    if (error instanceof DOMException) return error.name === 'AbortError';
    const code = (error as Readonly<{ code?: unknown }> | null)?.code;
    return code === 'cancelled' || code === 'aborted';
}
