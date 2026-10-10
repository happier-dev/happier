import { buildRemoteStackRetirementProbeCommand, buildRemoteStackStopCommand } from './remote_commands.mjs';
import { runDevTargetControlProcess } from './sync_project.mjs';
import { resolveDevTargetSshDiagnostic } from './ssh_transport.mjs';

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
