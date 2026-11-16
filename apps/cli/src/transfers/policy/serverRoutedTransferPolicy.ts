import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import {
    isServerRoutedTransferOverSizeLimit,
    resolveServerRoutedTransferMaxBytesFromEnv,
} from '@happier-dev/transfers';

export const SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR = 'File exceeds the server-routed transfer size limit';

export function resolveServerRoutedTransferMaxBytes(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): number | null {
    return resolveServerRoutedTransferMaxBytesFromEnv(env);
}

export { isServerRoutedTransferOverSizeLimit };
