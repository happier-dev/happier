export type EmitReadyIfIdleOptions = {
  pending: unknown;
  queueSize: () => number;
  shouldExit: boolean;
  sendReady: () => Promise<void>;
  notify?: () => void;
};

/**
 * Emits a ready event only when there is no in-flight work and no queued work.
 * Returns true when `sendReady` was invoked.
 */
export async function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: EmitReadyIfIdleOptions): Promise<boolean> {
  if (shouldExit) {
    return false;
  }
  if (pending) {
    return false;
  }
  if (queueSize() > 0) {
    return false;
  }

  await sendReady();
  notify?.();
  return true;
}
