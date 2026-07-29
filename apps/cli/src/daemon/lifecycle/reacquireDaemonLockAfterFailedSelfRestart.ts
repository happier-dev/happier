import type { DaemonShutdownSource } from './shutdown';

type RequestShutdown = (source: DaemonShutdownSource, errorMessage?: string) => void;

export async function reacquireDaemonLockAfterFailedSelfRestart<TLockHandle>({
  releasedDaemonLockForRestart,
  currentDaemonLockHandle,
  acquireDaemonLock,
  requestShutdown,
  resultStatus,
}: Readonly<{
  releasedDaemonLockForRestart: boolean;
  currentDaemonLockHandle: TLockHandle | null;
  acquireDaemonLock: () => Promise<TLockHandle | null>;
  requestShutdown: RequestShutdown;
  resultStatus: string;
}>): Promise<TLockHandle | null> {
  if (!releasedDaemonLockForRestart || currentDaemonLockHandle) {
    return currentDaemonLockHandle;
  }

  const reacquiredLockHandle = await acquireDaemonLock();
  if (reacquiredLockHandle) {
    return reacquiredLockHandle;
  }

  const message =
    `Daemon self-restart did not exit current process (${resultStatus}) ` +
    'and the current daemon could not reacquire its lifecycle lock; shutting down to avoid serving lockless.';
  requestShutdown('exception', message);
  throw new Error(message);
}
