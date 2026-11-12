import { checkDaemonStatePingAware } from '../daemon.mjs';
import { applyStackDaemonLifecycleScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { listStackCliIdentities, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { readStackRuntimeDaemonDesiredState } from '../utils/stack/runtime_daemon_state.mjs';
import { readSourceRuntimeBundleRecord, readSourceRuntimeSourceTime } from '../runtime/shared/source_bundle_record.mjs';

/** Status and reload consume the same identity-home inventory. */
export async function readStackDaemonParticipants({ stackName, stackBaseDir, runtimeState, cliHomeDir,
  serverUrl, env, defaultObservation, selected }) {
  const identities = await listStackCliIdentities({ cliHomeDir, runtimeState });
  const participants = await Promise.all(identities.map(async identity => {
    const desiredState = readStackRuntimeDaemonDesiredState(runtimeState, { cliIdentity: identity });
    const observation = identity === 'default' ? defaultObservation : await checkDaemonStatePingAware(
      resolveCliHomeDirForIdentity({ cliHomeDir, identity }), {
        stackName, serverUrl, env: applyStackDaemonLifecycleScopeEnv({
          env: { ...env, HAPPIER_STACK_CLI_IDENTITY: identity }, stackName, cliIdentity: identity,
        }),
      });
    // Unregistered homes participate only while a process is observed there.
    if (identity !== 'default'
      && !Object.hasOwn(runtimeState?.daemon?.desiredStateByIdentity ?? {}, identity)
      && !['running', 'starting', 'unreachable'].includes(observation?.status)) return null;
    if (desiredState === 'stopped' && observation?.status === 'stopped') {
      return { identity, status: 'stopped', selected, loaded: null, sourceTime: null, reason: null };
    }
    const entrypoint = observation?.runtimeEntrypoint;
    const record = observation?.status === 'running' && entrypoint
      ? await readSourceRuntimeBundleRecord(entrypoint).catch(() => null) : null;
    const loaded = record && record.entrypoint === entrypoint ? record.identity ?? null : null;
    const sourceTime = await readSourceRuntimeSourceTime({ stackBaseDir, component: 'daemon', identity: loaded, entrypoint });
    const reason = observation?.sourceRuntimeReloadRequired ? 'daemon_reload_required'
      : observation?.status !== 'running' ? 'participant_unavailable'
      : desiredState === 'stopped' ? 'daemon_stop_incomplete'
      : !selected || !loaded || !sourceTime ? 'participant_source_unknown'
      : loaded !== selected ? 'participant_source_stale' : null;
    return { identity, status: observation?.status ?? 'unknown', selected, loaded, sourceTime, reason };
  }));
  return participants.filter(Boolean);
}
