import { checkDaemonStatePingAware } from '../daemon.mjs';
import { applyStackDaemonLifecycleScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { readStackRuntimeDaemonDesiredState } from '../utils/stack/runtime_daemon_state.mjs';
import { readSourceRuntimeBundleRecord, readSourceRuntimeSourceTime } from '../runtime/shared/source_bundle_record.mjs';

/** The lifecycle owner's existing identity map is also the participant list. */
export async function readStackDaemonParticipants({ stackName, stackBaseDir, runtimeState, cliHomeDir,
  serverUrl, env, defaultObservation, selected }) {
  const identities = new Set(['default', ...Object.keys(runtimeState?.daemon?.desiredStateByIdentity ?? {})]);
  return await Promise.all([...identities].map(async identity => {
    const desiredState = readStackRuntimeDaemonDesiredState(runtimeState, { cliIdentity: identity });
    const observation = identity === 'default' ? defaultObservation : await checkDaemonStatePingAware(
      resolveCliHomeDirForIdentity({ cliHomeDir, identity }), {
        stackName, serverUrl, env: applyStackDaemonLifecycleScopeEnv({
          env: { ...env, HAPPIER_STACK_CLI_IDENTITY: identity }, stackName, cliIdentity: identity,
        }),
      });
    if (desiredState === 'stopped' && observation?.status === 'stopped') {
      return { identity, status: 'stopped', selected, loaded: null, sourceTime: null, reason: null };
    }
    const entrypoint = observation?.runtimeEntrypoint;
    const record = observation?.status === 'running' && entrypoint
      ? await readSourceRuntimeBundleRecord(entrypoint).catch(() => null) : null;
    const loaded = record && record.entrypoint === entrypoint ? record.identity ?? null : null;
    const sourceTime = await readSourceRuntimeSourceTime({ stackBaseDir, component: 'daemon', identity: loaded, entrypoint });
    const reason = observation?.status !== 'running' ? 'participant_unavailable'
      : desiredState === 'stopped' ? 'daemon_stop_incomplete'
      : !selected || !loaded || !sourceTime ? 'participant_source_unknown'
      : loaded !== selected ? 'participant_source_stale' : null;
    return { identity, status: observation?.status ?? 'unknown', selected, loaded, sourceTime, reason };
  }));
}
