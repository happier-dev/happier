import { StopSessionResultSchema } from '@happier-dev/protocol';
import {
  RPC_METHODS,
  resolveSocketRpcSessionWriteAuthorizationMethod,
} from '@happier-dev/protocol/rpc';
import type { SocketRpcTransportAcknowledgementV1 } from '@happier-dev/protocol/socketRpc';

export function projectMachineRpcTransportAcknowledgement(input: Readonly<{
  method: string;
  result: unknown;
}>): SocketRpcTransportAcknowledgementV1 | null {
  if (
    resolveSocketRpcSessionWriteAuthorizationMethod(input.method)
    !== RPC_METHODS.STOP_SESSION
  ) {
    return null;
  }
  const parsed = StopSessionResultSchema.safeParse(input.result);
  return parsed.success && parsed.data.status === 'stopped'
    ? { kind: 'session.stop', status: 'stopped' }
    : null;
}
