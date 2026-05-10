import {
  readRawRuntimeDescriptorV1FromMetadata,
  readRuntimeDescriptorV1ForProvider,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

import { asRecord, normalizeTrimmedString } from '../../runtime/identity/runtimeDescriptorShared.js';
import type { SharedRuntimeDescriptorByProviderId } from '../../runtime/identity/runtimeDescriptorTypes.js';

function buildPiRuntimeHandle(vendorSessionId: string | null): Readonly<Record<string, unknown>> | null {
  return vendorSessionId ? { vendorSessionId } : null;
}

export function readPiSessionMetadataRuntimeDescriptor(
  metadata: unknown,
): SharedRuntimeDescriptorByProviderId['pi'] | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const descriptor = readRuntimeDescriptorV1ForProvider(
    readRuntimeDescriptorV1FromMetadata(metadataRecord) ?? readRawRuntimeDescriptorV1FromMetadata(metadataRecord),
    'pi',
  );
  if (!descriptor) return null;
  const vendorSessionId = normalizeTrimmedString(descriptor.provider.vendorSessionId);
  return {
    providerId: 'pi',
    runtimeKind: null,
    vendorSessionId,
    runtimeHandle: buildPiRuntimeHandle(vendorSessionId),
  };
}
