import type { AcpForkContinuationHandler } from '@/session/fork/acpForkContinuationHandler';
import { buildVendorSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

export const codexAcpForkContinuationHandler: AcpForkContinuationHandler = async (params) => {
  const vendorSessionMetadata = buildVendorSessionIdSessionMetadata({
    metadataKey: 'codexSessionId',
    value: params.vendorSessionId,
  });

  return {
    spawn: {
      codexBackendMode: 'acp',
    },
    metadata: {
      ...vendorSessionMetadata,
      codexBackendMode: 'acp',
    },
    providerHint: {
      providerId: params.agentId,
      backendMode: 'acp',
      vendorSessionId: params.vendorSessionId,
    },
  };
};
