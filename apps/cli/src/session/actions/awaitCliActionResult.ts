import type { ActionExecuteResult } from '@happier-dev/protocol';

/** Cancel the caller's wait; the Action owner still records its eventual effect. */
export async function awaitCliActionResult(
  execute: () => Promise<ActionExecuteResult>,
  signal: AbortSignal | undefined,
): Promise<ActionExecuteResult> {
  if (!signal) return await execute();
  const cancelled: ActionExecuteResult = {
    ok: false,
    errorCode: 'cancelled',
    error: 'Action wait was cancelled; the Action may still be running and its outcome is unknown.',
    details: { outcome: 'unknown' },
  };
  if (signal.aborted) return cancelled;
  let onAbort!: () => void;
  const cancellation = new Promise<ActionExecuteResult>(resolve => {
    onAbort = () => resolve(cancelled);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([execute(), cancellation]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
