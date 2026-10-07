import { checkDaemonStatePingAware } from '../../daemon.mjs';
import { getObservedStackDaemonAsync } from '../stack/runtime_daemon_state.mjs';
import { hasStackCredentials } from '../auth/daemon_gate.mjs';
import { applyTuiStackAuthScopeEnv } from './stack_scope_env.mjs';
import { buildDaemonAuthNotice, parseStartDaemonFlagFromEnv } from './daemon_auth_notice.mjs';
import { resolveRuntimeRemoteServiceObservation } from './runtime_placement_summary.mjs';

export async function readTuiDaemonView({ stackName, cliHomeDir, internalServerUrl, runtime, env }) {
  const scopedEnv = applyTuiStackAuthScopeEnv({ env, stackName });
  const authed = hasStackCredentials({ cliHomeDir, serverUrl: internalServerUrl, env: scopedEnv });
  const observedDaemon = await getObservedStackDaemonAsync({
    cliHomeDir,
    internalServerUrl,
    stackName,
    runtimeDaemonPid: runtime?.processes?.daemonPid ?? null,
    runtimeDaemonPids: runtime?.processes?.daemonPids ?? [],
    env: scopedEnv,
  }, { checkDaemonStateImpl: checkDaemonStatePingAware });
  const remoteDaemon = resolveRuntimeRemoteServiceObservation(runtime, 'daemon');
  const daemonRunning = observedDaemon.running || remoteDaemon.running;
  const notice = buildDaemonAuthNotice({
    stackName,
    internalServerUrl,
    daemonPid: observedDaemon.pid,
    daemonRunning,
    authed,
    startDaemon: parseStartDaemonFlagFromEnv(env) && !remoteDaemon.target,
  });
  return { observedDaemon, daemonRunning, notice };
}

export function createTuiSummaryRefresh(refresh) {
  let inFlight = null;
  return () => {
    if (inFlight) return inFlight;
    const pending = Promise.resolve().then(refresh).finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  };
}
