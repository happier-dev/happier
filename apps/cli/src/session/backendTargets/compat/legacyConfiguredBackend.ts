export { isLegacyConfiguredAcpCompatible as isLegacyConfiguredBackendAgentCompatible, readLegacyConfiguredAcpBackendId as readLegacyConfiguredBackendIdFromLegacyAgent } from '@happier-dev/protocol/backends/targets/compat/customAcp';
export { readLegacyContinueWithReplayCompatBackendTargetInput as readLegacyReplayCompatBackendTargetInput } from '@happier-dev/protocol/backends/targets/compat/continueWithReplayRpcParamsCompat';
import { isLegacyConfiguredAcpFlavorCarrier, isLegacyCustomAcpId } from '@happier-dev/protocol/backends/targets/compat/customAcp';

export const LEGACY_REPLAY_BACKEND_TARGET_REQUIRED_ERROR = 'backendTarget is required for customAcp';

export function isLegacyConfiguredBackendSentinelId(value: unknown): value is string {
  return isLegacyCustomAcpId(value);
}

export function isConcreteLegacyConfiguredBackendId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim();
  return normalized.length > 0
    && !isLegacyCustomAcpId(normalized)
    && !isLegacyConfiguredAcpFlavorCarrier(normalized);
}
