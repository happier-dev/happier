import type { AcpForkContinuationHandler } from '@/backends/forking/acpForkContinuationHandler';

export const codexAcpForkContinuationHandler: AcpForkContinuationHandler = async (params) => ({
  spawn: {
    codexBackendMode: 'acp',
  },
  metadata: {
    codexSessionId: params.vendorSessionId,
    codexBackendMode: 'acp',
  },
  providerHint: {
    providerId: params.agentId,
    backendMode: 'acp',
    vendorSessionId: params.vendorSessionId,
  },
});
