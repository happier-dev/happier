/**
 * The one way a Triage source bounds an invocation it owns.
 *
 * `CONTRACT.md` §5.2 gives each source plugin — not Triage, and not the host — a positive private
 * deadline for every mounted detail read and every exact provider Action, and supplies neither a
 * public field nor a host timer to do it with. What that leaves each source to build is the same
 * three lines every time, and it is built here once for the same reason
 * {@link admitForgeRequestUrl} is: the rule does not vary by forge, and the copy that quietly
 * loses a `clearTimeout` or an `unref` is the one nobody reads again.
 *
 * What DOES vary — how long each operation may take, and what the timeout is called in this
 * forge's failure vocabulary — stays with the source. This module owns no constant and no
 * classification; it composes two signals and names the reason.
 */

/**
 * The caller's signal, additionally bounded by one deadline this source owns.
 *
 * The deadline aborts with a `TimeoutError` so the source's own classifier can tell it apart from
 * a caller cancellation: *this panel gave up on the provider* and *you navigated away* are
 * different answers, and reporting the first as the second hides a provider that stopped
 * answering. Whichever fired first travels through every provider boundary below.
 *
 * The timer is cleared the moment the caller's own signal aborts, and is unreferenced where the
 * runtime supports it, so work nobody is waiting for cannot hold the daemon open.
 *
 * It bounds the whole INVOCATION rather than each request, because that is what a person
 * experiences: several calls behind one panel, or behind one button, must not be allowed to wait
 * several times the number the source chose.
 */
export type BoundedInvocation = Readonly<{
  signal: AbortSignal;
  dispose(): void;
}>;

export function createBoundedInvocation(input: Readonly<{
  callerSignal?: AbortSignal;
  timeoutMs: number;
}>): BoundedInvocation {
  const deadline = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    input.callerSignal?.removeEventListener('abort', dispose);
  };
  timer = setTimeout(() => {
    dispose();
    deadline.abort(new DOMException('The provider invocation reached its deadline.', 'TimeoutError'));
  }, input.timeoutMs);
  (timer as unknown as Readonly<{ unref?: () => void }>).unref?.();
  input.callerSignal?.addEventListener('abort', dispose, { once: true });
  const signal = input.callerSignal === undefined
    ? deadline.signal
    : AbortSignal.any([input.callerSignal, deadline.signal]);
  if (input.callerSignal?.aborted === true) dispose();
  return Object.freeze({ signal, dispose });
}

/**
 * Whether an abort came from a source-owned deadline rather than from the caller.
 *
 * Sources classify their own transport failures, so this answers only the one question the shared
 * deadline above creates; the failure class and code it maps to stay with the source.
 */
export function isBoundedInvocationDeadline(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as Readonly<{ name?: unknown }>).name === 'TimeoutError';
}
