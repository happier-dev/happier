import { readSessionMetadataRuntimeDescriptor } from '../../sessionControls/agentRuntimeDescriptor.js';

export const PI_SESSION_CONTROL_ADAPTER = Object.freeze({
  resolveVendorResumeId(metadata: unknown): string | null {
    return readSessionMetadataRuntimeDescriptor(metadata, 'pi')?.vendorSessionId ?? null;
  },
});
