export {
  isLegacyConfiguredAcpCompatible as isLegacyConfiguredBackendAgentCompatible,
  readLegacyConfiguredAcpBackendId as readLegacyConfiguredBackendIdFromLegacyAgent,
  readLegacyContinueWithReplayCompatBackendTargetInput as readLegacyReplayCompatBackendTargetInput,
} from '@happier-dev/protocol';
import {
  isLegacyConfiguredAcpFlavorCarrier,
  isLegacyCustomAcpId,
} from '@happier-dev/protocol';

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

export function isLegacyConfiguredBackendVendorSessionCarrier(params: Readonly<{
  providerId: string;
  backendId: string;
}>): boolean {
  const providerId = params.providerId.trim();
  return isLegacyCustomAcpId(providerId) || providerId === `acp:${params.backendId}`;
}
