import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';

import { pingDaemon, requestDaemonSessionDrain } from '../utils/stack/daemonControlClient.mjs';
import { withStackDaemonLifecycleLock } from '../utils/stack/daemon_lifecycle_lock.mjs';
import { recordStackRuntimeDaemonDesiredState } from '../utils/stack/runtime_daemon_state.mjs';

export async function retireDaemonIdentity({ cliHomeDir, internalServerUrl, stackName, env, identity, runtimePath,
  startIdentity }) {
  const scope = { cliHomeDir, internalServerUrl, stackName };
  const failure = (error, details) => ({ ok: false, retired: false, error, ...details });
  const drain = () => withStackDaemonLifecycleLock(scope, async () => {
    const control = await pingDaemon({ ...scope, env, timeoutMs: null });
    if (!control.ok) return failure('daemon_control_unavailable', { reason: control.reason });

    let result;
    try {
      result = await requestDaemonSessionDrain(control);
    } catch (error) {
      if (error instanceof SyntaxError) return failure('product_result_missing');
      return failure('daemon_control_failed', {
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
        ...(typeof error?.cause?.code === 'string' ? { reason: error.cause.code } : {}),
      });
    }
    if (result?.status !== 'stopping' && result?.status !== 'session_cleanup_incomplete') {
      return failure('product_result_missing');
    }
    if (!Array.isArray(result.sessionResults)) return failure('product_result_missing');
    if (!result.sessionResults.every(entry =>
      typeof entry?.sessionId === 'string' && StopSessionResultSchema.safeParse(entry.result).success)) {
      return failure('product_result_missing');
    }
    const { sessionResults } = result;
    if (result.status === 'session_cleanup_incomplete') {
      return failure(result.status, { sessionResults });
    }
    await recordStackRuntimeDaemonDesiredState(runtimePath, 'stopped', { cliIdentity: identity });
    return { ok: true, retired: true, sessionResults, status: 'Session cleanup complete. Daemon shutdown accepted.' };
  });

  let outcome = await drain();
  if (outcome.error === 'daemon_control_unavailable'
    && ['missing_state', 'daemon_not_running'].includes(outcome.reason)) {
    const started = await startIdentity();
    if (started.ok === false) return { ...started, retired: false };
    outcome = await drain();
  }
  return outcome;
}
