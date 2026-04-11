import { readAgentRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

import { normalizeTrimmedString } from '../../sessionControls/runtimeDescriptorShared.js';
import type { SharedRuntimeDescriptorByProviderId } from '../../sessionControls/runtimeDescriptorTypes.js';

export function readPiSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): SharedRuntimeDescriptorByProviderId['pi'] | null {
  const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadataRecord.agentRuntimeDescriptorV1, 'pi');
  if (!descriptor) return null;
  return {
    providerId: 'pi',
    vendorSessionId: normalizeTrimmedString(descriptor.provider.vendorSessionId),
  };
}
