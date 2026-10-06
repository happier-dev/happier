import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveSocketRpcSessionWriteAuthorizationMethod } from '@happier-dev/protocol/socketRpc';
import type {
  SocketRpcTransportAcknowledgementV1,
} from '@happier-dev/protocol/socketRpc';

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
