import {
  SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
  isServerRoutedTransferOverSizeLimit,
  resolveServerRoutedTransferMaxBytesFromEnv,
} from '@happier-dev/transfers';

export const SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR = SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR;

export function resolveSessionRpcTransferMaxBytes(env: NodeJS.ProcessEnv = process.env): number | null {
  return resolveServerRoutedTransferMaxBytesFromEnv(env);
}

export { isServerRoutedTransferOverSizeLimit };
