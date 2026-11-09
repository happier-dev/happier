import { buildRemoteStackOperationCommand, buildRemoteStackRetirementProbeCommand, buildRemoteStackStopCommand } from './remote_commands.mjs';
import { runDevTargetControlProcess } from './sync_project.mjs';
import { resolveDevTargetSshDiagnostic } from './ssh_transport.mjs';
import { describeStackRuntimeCleanupFailure } from '../stack/stop_failure.mjs';

// Startup replacement, supervisor shutdown and an interrupted parent stop all
// delegate retirement to the native Stack owner. Transport loss is not cleanup.
export async function retireStackDevTarget({ target, options, sshArgs = [], env, probeBeforeStop = true },
  { runProcess = runDevTargetControlProcess, logger = console } = {}) {
  // Lifecycle control remains reachable when a shared master is saturated.
  // Do not retire the master: other jobs and synchronization still own it.
  const invoke = command => runProcess({ label: `remote:${target.name}`, command: 'ssh',
    args: [...sshArgs, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', target.ssh, command], env });
  const probe = () => invoke(buildRemoteStackRetirementProbeCommand(target, options));
  if (probeBeforeStop && (await probe())?.code === 0) return;
  const result = await invoke(buildRemoteStackStopCommand(target, options));
  if (result?.code === 0) return;
  // Cleanup can terminate its transport without publishing an exit status.
  // The same fresh absence probe proves retirement for every failed terminal
  // result; a signal or missing code alone never proves that Sessions are gone.
  const retirementProbe = await probe();
  if (retirementProbe?.code === 0) {
    logger.warn?.(`[dev-targets] ${target.name} prior Stack retirement transport closed (code=${String(result?.code ?? 'unknown')}) after cleanup was verified`);
    return;
  }
  // Consume the native Stop result, never diagnostic prose or a generic exit
  // code. A confirmed incomplete cleanup needs operator recovery, not another
  // expensive prepare/stop cycle. Ambiguous transport outcomes remain retryable.
  let stopped;
  try { stopped = JSON.parse(result?.out ?? ''); } catch {}
  const finalization = stopped?.stopped?.finalization;
  if (result?.code === 1 && stopped?.ok === false && finalization?.finalized === false
    && typeof finalization.reason === 'string' && /^[a-z][a-z0-9_]*$/.test(finalization.reason)) {
    // Native state lives in the target's namespace, not its default Stack home.
    // A stalled session drain also refuses /restart; canonical daemon Stop owns
    // acknowledged shutdown and verified retirement without repeating that drain.
    const recovery = `On ${target.name}, run:\n${buildRemoteStackStopCommand(target, { ...options, preserveDaemon: true })}`
      + `\nThen run:\n${buildRemoteStackOperationCommand(target, { ...options, operation: 'daemon', passthrough: ['stop', '--json'] })}`
      + '\nRetry the start from the controller. These commands preserve Agent Session processes.';
    const cause = Object.assign(new Error(`stop incomplete: ${describeStackRuntimeCleanupFailure(stopped.stopped)}`), { code: finalization.reason });
    throw Object.assign(new Error(`[dev-targets] ${target.name} prior Stack retirement refused: ${cause.message}. ${recovery}`, { cause }), {
      code: 'EDEVTARGETRETIREMENTREFUSED', phase: 'stop', retryable: false,
      commandExitCode: result.code, recovery, actions: stopped.stopped,
    });
  }
  const error = new Error(`[dev-targets] ${target.name} prior Stack retirement failed (code=${String(result?.code ?? 'unknown')})`
    + (result?.err ? `: ${String(result.err).trim()}` : ''));
  error.commandExitCode = result?.code;
  // Only a recognized connection failure, confirmed by the existing fresh
  // probe, permits the parent stop to release local custody. Authentication,
  // ambiguous disconnects and reachable native failures remain fail closed.
  if ([result, retirementProbe].every(value => value?.code === 255
    && ['ssh-connect-timeout', 'ssh-connect-unreachable'].includes(resolveDevTargetSshDiagnostic(value)))) {
    error.code = 'EDEVTARGETUNREACHABLE';
  }
  throw error;
}
