import {
  isServerRoutedTransferOverSizeLimit,
  resolveServerRoutedTransferMaxBytesFromEnv,
} from '@happier-dev/transfers';

export const SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR = 'Transfer exceeds the server-routed transfer size limit';

export function resolveServerRoutedTransferMaxBytes(env: NodeJS.ProcessEnv = process.env): number | null {
  return resolveServerRoutedTransferMaxBytesFromEnv(env);
}
export { isServerRoutedTransferOverSizeLimit };
