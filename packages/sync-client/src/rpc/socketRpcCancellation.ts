export function createSocketRpcRequestId(): string {
  const crypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  const raw = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `rpc_${raw}`;
}
export function createSocketRpcAbortError(): Error {
  return Object.assign(new Error('Socket RPC was aborted by the caller'), { name: 'AbortError', code: 'SOCKET_RPC_ABORTED' });
}
export function createSocketIoAckTimeoutError(): Error { return new Error('operation has timed out'); }
const MAX_NATIVE_TIMER_DELAY_MS = 2_147_483_647;
export function isSocketIoAckTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === 'operation has timed out';
}
export async function raceSocketIoAckTimeout<T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const deadlineAtMs = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(createSocketRpcAbortError()); };
    const armDeadline = () => {
      timer = setTimeout(() => {
        if (Date.now() < deadlineAtMs) { armDeadline(); return; }
        cleanup();
        reject(createSocketIoAckTimeoutError());
      }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, deadlineAtMs - Date.now())));
    };
    armDeadline();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}
export function issueSocketRpcCallWithCancellation<T>(params: Readonly<{
  signal?: AbortSignal; requestId?: string; onIssued?: () => void;
  issue: () => Promise<T>; emitCancel?: (requestId: string) => void;
}>): Promise<T> {
  if (params.signal?.aborted) return Promise.reject(createSocketRpcAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let issued = false;
    const cleanup = () => params.signal?.removeEventListener('abort', onAbort);
    const resolveOnce = (value: T) => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const rejectOnce = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const onAbort = () => {
      if (settled) return;
      if (issued && params.requestId) {
        try { params.emitCancel?.(params.requestId); } catch { /* Local cancellation still rejects while disconnected. */ }
      }
      rejectOnce(createSocketRpcAbortError());
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) { onAbort(); return; }
    try {
      params.onIssued?.();
      if (params.signal?.aborted) { onAbort(); return; }
      issued = true;
      params.issue().then(resolveOnce, rejectOnce);
    } catch (error) { rejectOnce(error); }
  });
}
