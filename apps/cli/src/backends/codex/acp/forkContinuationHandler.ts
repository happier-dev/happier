import type { AcpForkContinuationHandler } from '@/session/fork/acpForkContinuationHandler';
import { buildSessionStateFieldMetadataPatch } from '@happier-dev/agents/session/state/metadataPatch';

export const codexAcpForkContinuationHandler: AcpForkContinuationHandler = async (params) => {
  const vendorSessionMetadata = buildSessionStateFieldMetadataPatch('identity.vendorSessionId', {
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
