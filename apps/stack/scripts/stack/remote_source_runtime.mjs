import { loadDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { resolveDevTargetSshConfigFile } from '../utils/dev_targets/mutagen_runtime.mjs';
import { buildRemoteRuntimeSnapshotProbeCommand } from '../utils/dev_targets/remote_commands.mjs';
import { runDevTargetControlProcess } from '../utils/dev_targets/sync_project.mjs';

/** A request-scoped observation, never another persisted runtime identity. */
export async function observeRemoteSourceRuntime({ stackName, baseDir, runtimeState, env },
  { runProcess = runDevTargetControlProcess } = {}) {
  if (!runtimeState) return runtimeState;
  const requests = new Map();
  for (const component of ['server', 'daemon']) {
    const name = runtimeState.placement?.[component];
    const state = runtimeState.remoteTargets?.[name];
    if (state?.runtimeMode !== 'source-snapshot' || state.services?.[component] !== true
      || state.phase === 'stop' || state.status === 'retirement-pending'
      || ['stopped', 'not-running'].includes(state.serviceStatus?.[component] ?? state.status)) continue;
    if (!requests.has(name)) requests.set(name, {});
    requests.get(name)[component] = true;
  }
  if (requests.size === 0) return runtimeState;
  const loaded = await loadDevTargetsConfig({ stackName, env }).catch(() => null);
  const remoteTargets = { ...runtimeState.remoteTargets };
  await Promise.all([...requests].map(async ([name, services]) => {
    const target = loaded?.config.targets.find(candidate => candidate.name === name);
    let observed;
    if (target) {
      try {
        const configFile = resolveDevTargetSshConfigFile(target, { stackBaseDir: baseDir, env });
        const result = await runProcess({ command: 'ssh', silent: true, env,
          args: [...(configFile ? ['-F', configFile] : []), '-o', 'BatchMode=yes', target.ssh,
            buildRemoteRuntimeSnapshotProbeCommand(target, { stackName, runtimeMode: 'source-snapshot',
              services, observeLive: true })] });
        if (result.code === 0) observed = JSON.parse(result.out);
      } catch { /* Unavailable observation cannot attest an old loaded process. */ }
    }
    const previous = remoteTargets[name];
    const serviceStatus = { ...previous.serviceStatus };
    const sourceRuntimeIdentities = { ...previous.sourceRuntimeIdentities };
    for (const component of Object.keys(services)) {
      const identity = observed?.sourceRuntimeIdentities?.[component];
      const status = observed?.serviceStatus?.[component];
      serviceStatus[component] = typeof status === 'string' ? status : 'unknown';
      sourceRuntimeIdentities[component] = {
        selected: typeof identity?.selected === 'string' ? identity.selected
          : sourceRuntimeIdentities[component]?.selected ?? runtimeState.sourceRuntimeIdentities?.[component]?.selected ?? null,
        loaded: status === 'running' && typeof identity?.loaded === 'string' ? identity.loaded : null,
        ...(status === 'running' && typeof identity?.sourceTime === 'string' && Number.isFinite(Date.parse(identity.sourceTime))
          ? { sourceTime: new Date(identity.sourceTime).toISOString() } : {}),
      };
    }
    remoteTargets[name] = { ...previous, serviceStatus, sourceRuntimeIdentities,
      ...(services.daemon ? { managedCli: observed?.managedCli ?? null } : {}),
      ...(services.daemon ? { daemonEntry: observed?.daemonEntry ?? null } : {}) };
  }));
  return { ...runtimeState, remoteTargets };
}
