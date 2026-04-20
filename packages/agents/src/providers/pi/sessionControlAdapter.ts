import { asRecord } from '../../runtime/identity/runtimeDescriptorShared.js';
import { readPiSessionMetadataRuntimeDescriptor } from './readSessionMetadataRuntimeDescriptor.js';

export const PI_SESSION_CONTROL_ADAPTER = Object.freeze({
  resolveVendorResumeId(metadata: unknown): string | null {
    const metadataRecord = asRecord(metadata);
    return metadataRecord ? readPiSessionMetadataRuntimeDescriptor(metadataRecord)?.vendorSessionId ?? null : null;
  },
});
