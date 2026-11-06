export type { RpcErrorCode } from '@happier-dev/protocol/rpc';
export {
  createRpcCallError,
  interpretRpcResult,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  readRpcErrorCode,
  RpcError,
  type RpcErrorCarrier,
} from '@happier-dev/protocol/rpcErrors';
