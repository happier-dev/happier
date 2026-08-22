export type RpcRequestDisposition = 'notSent' | 'outcomeUnknown';

const RPC_REQUEST_DISPOSITION = Symbol('rpcRequestDisposition');

export function markRpcRequestDisposition(
  error: unknown,
  disposition: RpcRequestDisposition,
): unknown {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try {
      Object.defineProperty(error, RPC_REQUEST_DISPOSITION, {
        configurable: true,
        value: disposition,
      });
      return error;
    } catch {
      // Fall through to a preserving wrapper for frozen/non-extensible values.
    }
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
    cause: error,
    [RPC_REQUEST_DISPOSITION]: disposition,
  });
}

export function readRpcRequestDisposition(error: unknown): RpcRequestDisposition | null {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return null;
  const disposition = (error as { [RPC_REQUEST_DISPOSITION]?: unknown })[RPC_REQUEST_DISPOSITION];
  return disposition === 'notSent' || disposition === 'outcomeUnknown' ? disposition : null;
}
