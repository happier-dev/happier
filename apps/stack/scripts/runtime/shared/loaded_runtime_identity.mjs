import { resolveRuntimeRemoteServiceObservation } from '../../utils/tui/runtime_placement_summary.mjs';
import { readSourceRuntimeSourceTime } from './source_bundle_record.mjs';

/** Project loaded identities from the caller's existing lifecycle observations. */
export function projectLoadedSourceRuntimeIdentities({ runtimeState, sourceSnapshot, runtimeLifecycleLive,
  serverRunning, uiRunning, daemonRunning }) {
  if (!sourceSnapshot) return null;
  const recorded = { ...runtimeState?.sourceRuntimeIdentities };
  for (const component of ['server', 'daemon']) {
    const observation = resolveRuntimeRemoteServiceObservation(runtimeState, component);
    const identity = runtimeState?.remoteTargets?.[observation.target]?.sourceRuntimeIdentities?.[component];
    if (identity) recorded[component] = identity;
  }
  return Object.fromEntries(Object.entries(recorded).map(([component, identity]) => {
    const observation = resolveRuntimeRemoteServiceObservation(runtimeState,
      component === 'server' || component === 'daemon' ? component : 'expo');
    const remoteCustodyUnconfirmed = observation.target && !['stopped', 'not-running'].includes(observation.status);
    const localRunning = component === 'server' ? serverRunning : component === 'ui' ? uiRunning : daemonRunning;
    const loaded = remoteCustodyUnconfirmed || (runtimeLifecycleLive && localRunning) ? identity.loaded : null;
    const sourceTime = loaded && typeof identity.sourceTime === 'string' && Number.isFinite(Date.parse(identity.sourceTime))
      ? new Date(identity.sourceTime).toISOString() : null;
    return [component, { selected: identity.selected, loaded, ...(sourceTime ? { sourceTime } : {}) }];
  }));
}

/** Local completion metadata or the target's existing observation, never a new probe. */
export async function readLoadedSourceRuntimeIdentities({ stackBaseDir, ...options }) {
  const identities = projectLoadedSourceRuntimeIdentities(options);
  if (!identities) return identities;
  return Object.fromEntries(await Promise.all(Object.entries(identities).map(async ([component, identity]) => {
    const remote = resolveRuntimeRemoteServiceObservation(options.runtimeState,
      component === 'server' || component === 'daemon' ? component : 'expo');
    if (!identity.loaded || identity.sourceTime || remote.target) return [component, identity];
    const sourceTime = await readSourceRuntimeSourceTime({ stackBaseDir, component, identity: identity.loaded });
    return [component, { ...identity, ...(sourceTime ? { sourceTime } : {}) }];
  })));
}

export function projectLoadedRuntimeSnapshotId({ runtimeState, sourceSnapshot, runtimeLifecycleLive }) {
  return !sourceSnapshot && runtimeLifecycleLive ? String(runtimeState?.runtimeSnapshotId ?? '').trim() || null : null;
}
