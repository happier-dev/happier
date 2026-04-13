import { readSessionMetadataRuntimeDescriptor } from '../readSessionMetadataRuntimeDescriptor.js';

export const PI_SESSION_CONTROL_ADAPTER = Object.freeze({
  resolveVendorResumeId(metadata: unknown): string | null {
    return readSessionMetadataRuntimeDescriptor(metadata, 'pi')?.vendorSessionId ?? null;
  },
});
