import type { DaemonShutdownSource } from './shutdown';
import {
  requestDaemonSelfRestart,
  type RequestDaemonSelfRestartResult,
} from './requestDaemonSelfRestart';
import { reacquireDaemonLockAfterFailedSelfRestart } from './reacquireDaemonLockAfterFailedSelfRestart';

type RequestShutdown = (source: DaemonShutdownSource, errorMessage?: string) => void;

type RequestDaemonSelfRestart = typeof requestDaemonSelfRestart;

export function resolveDaemonSelfRestartEnvironment(
  successorDistClosureFingerprint: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!successorDistClosureFingerprint) return undefined;
  return {
    ...env,
    HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: successorDistClosureFingerprint,
  };
}

export async function requestDaemonSelfRestartWithLockHandoff<TLockHandle>({
  getCurrentDaemonLockHandle,
  setCurrentDaemonLockHandle,
  quiesceBeforeLockRelease,
  releaseDaemonLock,
  acquireDaemonLock,
  requestShutdown,
  requestSelfRestart = requestDaemonSelfRestart,
  selfRestartParams,
}: Readonly<{
  getCurrentDaemonLockHandle: () => TLockHandle | null;
  setCurrentDaemonLockHandle: (lockHandle: TLockHandle | null) => void;
  quiesceBeforeLockRelease: () => Promise<Readonly<{ resume: () => void | Promise<void> }>>;
  releaseDaemonLock: (lockHandle: TLockHandle) => Promise<void>;
  acquireDaemonLock: () => Promise<TLockHandle | null>;
  requestShutdown: RequestShutdown;
  requestSelfRestart?: RequestDaemonSelfRestart;
  selfRestartParams: Parameters<RequestDaemonSelfRestart>[0];
}>): Promise<RequestDaemonSelfRestartResult> {
  const quiescence = await quiesceBeforeLockRelease();
  let releasedDaemonLockForRestart = false;
  const daemonLockHandle = getCurrentDaemonLockHandle();
  if (daemonLockHandle) {
    try {
      await releaseDaemonLock(daemonLockHandle);
    } catch (error) {
      await quiescence.resume();
      throw error;
    }
    setCurrentDaemonLockHandle(null);
    releasedDaemonLockForRestart = true;
  }

  let result: RequestDaemonSelfRestartResult;
  try {
    result = await requestSelfRestart(selfRestartParams);
  } catch (error) {
    const reacquired = await reacquireDaemonLockAfterFailedSelfRestart({
      releasedDaemonLockForRestart,
      currentDaemonLockHandle: getCurrentDaemonLockHandle(),
      acquireDaemonLock,
      requestShutdown,
      resultStatus: 'threw',
    });
    setCurrentDaemonLockHandle(reacquired);
    await quiescence.resume();
    throw error;
  }

  if (result.status !== 'exited') {
    const reacquired = await reacquireDaemonLockAfterFailedSelfRestart({
      releasedDaemonLockForRestart,
      currentDaemonLockHandle: getCurrentDaemonLockHandle(),
      acquireDaemonLock,
      requestShutdown,
      resultStatus: result.status,
    });
    setCurrentDaemonLockHandle(reacquired);
    await quiescence.resume();
  }

  return result;
}
