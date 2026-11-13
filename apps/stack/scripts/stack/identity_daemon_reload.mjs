import { join } from 'node:path';
import { readJsonIfExists, writeJsonAtomic } from '../utils/fs/json.mjs';
import { checkDaemonStatePingAware } from '../daemon.mjs';
import { applyStackDaemonLifecycleScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { listStackCliIdentities, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { readStackRuntimeDaemonDesiredState } from '../utils/stack/runtime_daemon_state.mjs';

function typedReason(value) {
  const candidate = String(value ?? '').trim();
  return /^[a-zA-Z][a-zA-Z0-9_:-]{1,80}$/.test(candidate) ? candidate : 'daemon_start_failed';
}

export async function readRunningStackIdentityDaemons({
  runtimeState,
  cliHomeDir,
  stackName,
  serverUrl,
  env,
  excludeRuntimeEntrypoint = null,
  skipped = [],
} = {}, {
  checkDaemonStateImpl = checkDaemonStatePingAware,
} = {}) {
  const identities = (await listStackCliIdentities({ cliHomeDir, runtimeState }))
    .filter((identity) => identity !== 'default');
  const running = [];
  const skip = (identity, reason) => {
    skipped.push({ identity, reason });
    console.warn(`[stack] ${stackName}: identity daemon ${identity} skipped (reason=${reason})`);
  };
  for (const identity of identities) {
    if (readStackRuntimeDaemonDesiredState(runtimeState, { cliIdentity: identity }) !== 'running') {
      skip(identity, 'owner_stopped');
      continue;
    }
    let observation;
    try {
      observation = await checkDaemonStateImpl(resolveCliHomeDirForIdentity({ cliHomeDir, identity }), {
        stackName,
        serverUrl,
        env: applyStackDaemonLifecycleScopeEnv({
          env: { ...env, HAPPIER_STACK_CLI_IDENTITY: identity }, stackName, cliIdentity: identity,
        }),
      });
    } catch (error) {
      skip(identity, typedReason(error?.code ?? error?.reason));
      continue;
    }
    if (observation?.status === 'unreachable') {
      skip(identity, typedReason(observation.reason));
      continue;
    }
    if (observation?.status === 'running'
      && (!excludeRuntimeEntrypoint || observation.runtimeEntrypoint !== excludeRuntimeEntrypoint)) {
      running.push(identity);
    } else {
      skip(identity, observation?.status === 'running' ? 'already_selected' : typedReason(observation?.status ?? 'not_running'));
    }
  }
  return running;
}

export async function restartStackIdentityDaemons({
  rootDir,
  stackName,
  identities = [],
  skipped = [],
  stackBaseDir,
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
  const refusal = (identity, value) => ({
    identity,
    ...(value?.code ? { code: typedReason(value.code) } : {}),
    reason: typedReason(value?.reason ?? value?.error ?? value?.code),
  });
  for (const identity of identities) {
    let outcome;
    try {
      const result = await startIdentityDaemonImpl(identity);
      if (result?.ok === false || result?.started === false) {
        if (result?.reason === 'daemon-stopped-by-owner') {
          skipped.push({ identity, reason: result.reason });
          outcome = `skipped (reason=${result.reason})`;
        } else {
          const failure = refusal(identity, result);
          failures.push(failure);
          outcome = `refused (${failure.code ? `code=${failure.code} ` : ''}reason=${failure.reason})`;
        }
      } else {
        started.push(identity);
        outcome = 'restored';
      }
    } catch (error) {
      const failure = refusal(identity, error);
      failures.push(failure);
      outcome = `refused (${failure.code ? `code=${failure.code} ` : ''}reason=${failure.reason})`;
    }
    const line = `[stack] ${stackName}: identity daemon ${identity} ${outcome}`;
    if (outcome === 'restored') console.log(line);
    else console.warn(line);
  }
  const result = { started, failures };
  // Diagnostics extend the existing reload record, never its readiness decision.
  if (stackBaseDir && (identities.length || skipped.length)) {
    const path = join(stackBaseDir, 'source-runtime/reload.json');
    try {
      const previous = await readJsonIfExists(path);
      await writeJsonAtomic(path, { ...previous, identityRestore: { ...result, skipped } });
    } catch (error) {
      console.warn(`[stack] ${stackName}: identity restore status publication failed (code=${typedReason(error?.code)})`);
    }
  }
  return result;
}
