import { normalizeStackRuntimeOwnerStartedAt } from '../utils/stack/runtime_owner_incarnation.mjs';
import { resolveRuntimeRemoteServiceObservation } from '../utils/tui/runtime_placement_summary.mjs';

export function isBackgroundServerPublished(runtimeState, expectedRuntimeState) {
  const ownerStartedAt = Date.parse(String(normalizeStackRuntimeOwnerStartedAt(runtimeState?.startedAt) ?? ''));
  const expectedStartedAt = Date.parse(String(normalizeStackRuntimeOwnerStartedAt(expectedRuntimeState?.startedAt) ?? ''));
  if (Number(runtimeState?.ownerPid) !== Number(expectedRuntimeState?.ownerPid)
    || !Number.isFinite(ownerStartedAt) || !Number.isFinite(expectedStartedAt)
    || ownerStartedAt < expectedStartedAt || runtimeState?.stopRequest) return false;

  const remoteServer = resolveRuntimeRemoteServiceObservation(runtimeState, 'server');
  if (remoteServer.target) return remoteServer.running;
  // A managed backend publishes before the public gateway has joined Stop's
  // process membership. Its final activation must be published as well.
  return runtimeState?.serverProxy?.mode !== 'managed-backend'
    && (Number(runtimeState?.processes?.serverPid) > 1 || Number(runtimeState?.processes?.serverWrapperPid) > 1);
}
