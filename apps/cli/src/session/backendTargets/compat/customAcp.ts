export {
  isLegacyCustomAcpId as isLegacyCustomAcpSessionAgentId,
  isLegacyConfiguredAcpCompatible as isLegacyConfiguredAcpAgentCompatible,
  isLegacyConfiguredAcpFlavorCarrier,
  readLegacyContinueWithReplayCompatBackendTargetInput,
  readLegacyConfiguredAcpBackendId as readLegacyConfiguredAcpBackendIdFromAgent,
} from '@happier-dev/protocol';
import { isLegacyConfiguredAcpFlavorCarrier } from '@happier-dev/protocol';

export function isConcreteBackendTargetCompatId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.trim().length > 0
    && value.trim() !== 'customAcp'
    && !isLegacyConfiguredAcpFlavorCarrier(value)
  );
}
