import {
  ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
  ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceQuotaRecoveryCreditConsumeResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { notifyDaemonConnectedServiceQuotaRecoveryCreditConsume } from '@/daemon/controlClient';
import type { RpcHandlerRegistrar } from '../rpc/types';

function failure(errorCode: string, error = errorCode): ConnectedServiceQuotaRecoveryCreditConsumeResponseV1 {
  return { ok: false, errorCode, error };
}

function unwrapDaemonResult(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) {
    return (value as { result?: unknown }).result;
  }
  return value;
}

export function registerMachineConnectedServiceQuotaRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
}>): void {
  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
    async (raw: unknown): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResponseV1> => {
      const request = ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.safeParse(raw);
      if (!request.success) return failure('invalid_parameters');
      const legacyServiceId = ConnectedServiceIdSchema.safeParse(request.data.serviceId);
      if (!legacyServiceId.success) return failure('invalid_parameters');

      try {
        const daemonResponse = await notifyDaemonConnectedServiceQuotaRecoveryCreditConsume({
          ...request.data,
          serviceId: legacyServiceId.data,
        });
        if (daemonResponse?.error) {
          return failure('daemon_control_failed', String(daemonResponse.error));
        }
        const parsed = ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.safeParse(unwrapDaemonResult(daemonResponse));
        if (!parsed.success) return failure('invalid_daemon_response');
        return parsed.data;
      } catch (error) {
        return failure('daemon_control_failed', error instanceof Error ? error.message : 'daemon_control_failed');
      }
    },
  );
}
