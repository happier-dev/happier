/**
 * This source's own bound on an invocation nobody else bounds.
 *
 * Triage owns the deadline for the three invocations it starts — `listInstances`,
 * `scan` and `get` — and supplies none for anything else. A mounted detail read
 * and a Connected Account confirmation are both started by a person looking at a
 * surface, and Sentry can accept a connection and then neither answer nor fail:
 * a self-hosted deployment behind a stalled proxy, or a Cloud region whose
 * request is black-holed. Without a bound of our own the panel shows its loading
 * state, or the connect dialog its spinner, until the mount is torn down — an
 * outcome the reader cannot retry, cannot report, and cannot tell apart from a
 * very slow provider.
 *
 * The bound covers the WHOLE invocation rather than each request, because that
 * is what the person experiences: a read that materializes an account and then
 * fetches must not be allowed to wait twice the number its caller declared.
 */

/**
 * The caller's signal, additionally bounded by this source's own deadline.
 *
 * The deadline aborts with a `TimeoutError` so the failure owner can tell it
 * apart from a caller cancellation, which is a different fact and a different
 * sentence. `AbortSignal.any` carries whichever fired first through to every
 * provider boundary below. The timer is dropped as soon as the caller's own
 * signal aborts and is unreferenced, so work nobody is waiting for cannot hold
 * the daemon open.
 */
export function boundSentryInvocation(
  callerSignal: AbortSignal,
  deadlineMs: number,
): AbortSignal {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException(
      'Sentry did not answer within this invocation deadline.',
      'TimeoutError',
    ));
  }, deadlineMs);
  (timer as unknown as Readonly<{ unref?: () => void }>).unref?.();
  callerSignal.addEventListener('abort', () => { clearTimeout(timer); }, { once: true });
  return AbortSignal.any([callerSignal, deadline.signal]);
}

/**
 * Whether an aborted signal was aborted by one of these deadlines rather than by
 * the caller.
 *
 * A person who navigates away cancelled; a deployment that never answered did
 * not. Reporting the second as the first hides a stalled Sentry behind a word
 * that tells the reader nothing is wrong.
 */
export function isSentryDeadlineAbort(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return typeof reason === 'object'
    && reason !== null
    && (reason as Readonly<{ name?: unknown }>).name === 'TimeoutError';
}
