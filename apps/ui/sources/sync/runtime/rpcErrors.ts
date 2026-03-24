export type { RpcErrorCode } from '@happier-dev/protocol/rpc';
export {
  createRpcCallError,
  isRpcMethodNotAvailableError,
  isRpcMethodNotFoundError,
  readRpcErrorCode,
  RpcError,
  type RpcErrorCarrier,
} from '@happier-dev/protocol/rpcErrors';
