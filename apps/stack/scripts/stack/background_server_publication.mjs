import { normalizeStackRuntimeOwnerStartedAt } from '../utils/stack/runtime_owner_incarnation.mjs';
import { resolveRuntimeRemoteServiceObservation } from '../utils/tui/runtime_placement_summary.mjs';

/** @returns {{status: 'pending'} | {status: 'published', remote: boolean, readiness?: 'sign-in-required'} | {status: 'failed', error: Error}} */
export function readBackgroundServicePublication(runtimeState, expectedRuntimeState, service = 'server') {
  const ownerStartedAt = Date.parse(String(normalizeStackRuntimeOwnerStartedAt(runtimeState?.startedAt) ?? ''));
  const expectedStartedAt = Date.parse(String(normalizeStackRuntimeOwnerStartedAt(expectedRuntimeState?.startedAt) ?? ''));
  if (Number(runtimeState?.ownerPid) !== Number(expectedRuntimeState?.ownerPid)
    || !Number.isFinite(ownerStartedAt) || !Number.isFinite(expectedStartedAt)
    || ownerStartedAt < expectedStartedAt || runtimeState?.stopRequest) return { status: 'pending' };

  const remoteService = resolveRuntimeRemoteServiceObservation(runtimeState, service);
  if (remoteService.target) {
    const state = runtimeState.remoteTargets?.[remoteService.target];
    if (remoteService.running) return { status: 'published', remote: true };
    if (service === 'daemon' && state?.services?.daemon === true && remoteService.status === 'sign-in-required') {
      return { status: 'published', remote: true, readiness: 'sign-in-required' };
    }
    if (['failed', 'degraded'].includes(state?.status) && state.error) {
      return { status: 'failed', error: Object.assign(new Error(state.error), {
        code: state.reason, phase: state.phase,
      }) };
    }
    return { status: 'pending' };
  }
  // A managed backend publishes before the public gateway has joined Stop's
  // process membership. Its final activation must be published as well.
  return service === 'server' && runtimeState?.serverProxy?.mode !== 'managed-backend'
    && (Number(runtimeState?.processes?.serverPid) > 1 || Number(runtimeState?.processes?.serverWrapperPid) > 1)
    ? { status: 'published', remote: false } : { status: 'pending' };
}
