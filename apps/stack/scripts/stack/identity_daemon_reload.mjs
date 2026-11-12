import { checkDaemonStatePingAware } from '../daemon.mjs';
import { applyStackDaemonLifecycleScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { listStackCliIdentities, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { readStackRuntimeDaemonDesiredState } from '../utils/stack/runtime_daemon_state.mjs';

export async function readRunningStackIdentityDaemons({
  runtimeState,
  cliHomeDir,
  stackName,
  serverUrl,
  env,
  excludeRuntimeEntrypoint = null,
} = {}, {
  checkDaemonStateImpl = checkDaemonStatePingAware,
} = {}) {
  const identities = (await listStackCliIdentities({ cliHomeDir, runtimeState }))
    .filter((identity) => identity !== 'default')
    .filter((identity) => readStackRuntimeDaemonDesiredState(runtimeState, { cliIdentity: identity }) === 'running');
  const running = [];
  for (const identity of identities) {
    const observation = await checkDaemonStateImpl(resolveCliHomeDirForIdentity({ cliHomeDir, identity }), {
      stackName,
      serverUrl,
      env: applyStackDaemonLifecycleScopeEnv({
        env: { ...env, HAPPIER_STACK_CLI_IDENTITY: identity }, stackName, cliIdentity: identity,
      }),
    });
    if (observation?.status === 'running'
      && (!excludeRuntimeEntrypoint || observation.runtimeEntrypoint !== excludeRuntimeEntrypoint)) {
      running.push(identity);
    }
  }
  return running;
}

export async function restartStackIdentityDaemons({
  rootDir,
  stackName,
  identities = [],
  env,
} = {}, {
  startIdentityDaemonImpl = async (identity) => {
    const { runStackDaemonCommand } = await import('./stack_daemon_command.mjs');
    return await runStackDaemonCommand({
      rootDir,
      stackName,
      argv: [
        'restart',
        ...(String(env?.HAPPIER_STACK_RUNTIME_MODE ?? '').trim() === 'source' ? ['--runtime=source'] : []),
        `--identity=${identity}`,
      ],
      json: true,
      emitResult: false,
      env,
    });
  },
} = {}) {
  const started = [];
  const failures = [];
  const typedReason = (value) => {
    const candidate = String(value ?? '').trim();
    return /^[a-z][a-z0-9_:-]{1,80}$/.test(candidate) ? candidate : 'daemon_start_failed';
  };
  for (const identity of identities) {
    try {
      const result = await startIdentityDaemonImpl(identity);
      if (result?.ok === false) {
        failures.push({ identity, reason: typedReason(result.reason ?? result.error) });
      } else {
        started.push(identity);
      }
    } catch (error) {
      failures.push({
        identity,
        reason: typedReason(error?.code ?? error?.reason),
      });
    }
  }
  for (const failure of failures) {
    console.warn(`[stack] ${stackName}: identity daemon ${failure.identity} was not restarted (reason=${failure.reason})`);
  }
  return { started, failures };
}
