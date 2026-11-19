import { spawn } from 'node:child_process';
import { getRepoDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { loadDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { resolveObservedDevTargetService } from '../utils/dev_targets/service_placement.mjs';
import { hasExplicitStackRuntimeModeArg, resolveStackRuntimeMode } from '../runtime/shared/runtime_mode.mjs';
import { resolveDevTargetMutagenRuntime, resolveDevTargetSshConfigFile } from '../utils/dev_targets/mutagen_runtime.mjs';
import { flushDevTargetSync, runDevTargetControlProcess } from '../utils/dev_targets/sync_project.mjs';
import { buildRemoteRuntimeSnapshotProbeCommand, buildRemoteStackOperationCommand, buildSshWorkerArgs } from '../utils/dev_targets/remote_commands.mjs';
import { recordStackRuntimeUpdate } from '../utils/stack/runtime_state.mjs';
import { formatFailureDiagnostic, redactFailureDiagnostic } from '../utils/proc/proc.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import { parseCliIdentityOrThrow } from '../utils/stack/cli_identities.mjs';

/** Auth follows daemon placement, including an explicit recovery runtime. */
export async function resolveRemoteStackAuthPlacement({ stackName, env, runtimeState, argv = [] }) {
  if (env.HAPPIER_DEV_TARGET_EXECUTION === '1') return null;
  const { config } = await loadDevTargetsConfig({ stackName, env });
  const placed = resolveObservedDevTargetService({ config, runtimeState, service: 'daemon' });
  if (!placed) return null;
  const mode = resolveStackRuntimeMode({ argv, env, activeRuntimeState: runtimeState }).mode;
  const requestedMode = mode === 'source-snapshot' ? mode : mode === 'require' ? 'controlled' : 'source';
  return { ...placed, runtimeMode: hasExplicitStackRuntimeModeArg(argv) ? requestedMode
    : runtimeState?.remoteTargets?.[placed.target.name]?.runtimeMode ?? requestedMode };
}

/** Keep interactive stdin and terminal custody across the existing SSH boundary. */
export async function runRemoteStackCommand({ target, stackName, remoteCommand, env }) {
  const configFile = resolveDevTargetSshConfigFile(target, { stackBaseDir: resolveStackEnvPath(stackName, env).baseDir, env });
  const child = spawn('ssh', buildSshWorkerArgs(target, { remoteCommand,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY), sshArgs: configFile ? ['-F', configFile] : [],
  }), { env, stdio: 'inherit', shell: false });
  return await new Promise(resolve => {
    child.on('error', error => { console.error(`[stack] ${error.message}`); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
}

/** Reuse the transport, freshness barrier and retained Stack scope for narrow commands. */
export async function runRemoteStackOperation({ rootDir, stackName, placed, operation, passthrough, env, relayResult = false },
  { runProcess = runDevTargetControlProcess } = {}) {
  const { target, runtimeMode } = placed;
  const { baseDir } = resolveStackEnvPath(stackName, env);
  const sync = resolveDevTargetMutagenRuntime({ stackBaseDir: baseDir, sourceDir: getRepoDir(rootDir, env), env });
  await flushDevTargetSync({ target, env: sync.env }, { runProcess });
  const configFile = resolveDevTargetSshConfigFile(target, { stackBaseDir: baseDir, env });
  const sshArgs = configFile ? ['-F', configFile] : [];
  const result = await runProcess({ command: 'ssh', env,
    args: buildSshWorkerArgs(target, {
      remoteCommand: buildRemoteStackOperationCommand(target, { stackName, runtimeMode, operation, passthrough, quiet: relayResult }),
      sshArgs,
    }) });
  if (relayResult) {
    const diagnostics = redactFailureDiagnostic(result.err, env);
    if (result.out) process.stdout.write(result.out);
    if (diagnostics) process.stderr.write(diagnostics + '\n');
    return result.code ?? 1;
  }
  if (result.code !== 0) throw new Error(`[stack] remote ${operation} failed (code=${result.code})`
    + formatFailureDiagnostic({ out: result.out, err: result.err, env }));
  const updatesDefaultDaemon = operation === 'daemon'
    && parseCliIdentityOrThrow(parseArgs(passthrough).kv.get('--identity')) === 'default';
  if (updatesDefaultDaemon && (passthrough.includes('start') || passthrough.includes('restart'))
    && runtimeMode === 'source-snapshot') {
    const observation = await runProcess({ command: 'ssh', env,
      args: [...sshArgs, '-o', 'BatchMode=yes', target.ssh,
        buildRemoteRuntimeSnapshotProbeCommand(target, { stackName, runtimeMode, services: { daemon: true } })] });
    if (observation.code !== 0) throw new Error('[stack] restarted source daemon identity is not loaded'
      + formatFailureDiagnostic({ out: observation.out, err: observation.err, env }));
    const { sourceRuntimeIdentities } = JSON.parse(observation.out);
    if (!sourceRuntimeIdentities?.daemon?.selected
      || sourceRuntimeIdentities.daemon.loaded !== sourceRuntimeIdentities.daemon.selected) {
      throw new Error('[stack] restarted source daemon identity is not loaded');
    }
    await recordStackRuntimeUpdate(env.HAPPIER_STACK_RUNTIME_STATE_PATH, {
      placement: { daemon: target.name },
      sourceRuntimeIdentities,
      // The next server-only start consumes observed daemon custody, not just
      // its configured target or a source identity without a recorded role.
      remoteTargets: { [target.name]: { runtimeMode, services: { daemon: true },
        serviceStatus: { daemon: 'running' }, sourceRuntimeIdentities } },
    });
  }
  process.stdout.write(result.out || '');
}
