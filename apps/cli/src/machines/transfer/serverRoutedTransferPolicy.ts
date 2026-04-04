export {
    isServerRoutedTransferOverSizeLimit,
    resolveServerRoutedTransferMaxBytes,
} from '@/transfers/policy/serverRoutedTransferPolicy';

export const SERVER_ROUTED_TRANSFER_SIZE_LIMIT_ERROR = 'Transfer exceeds the server-routed transfer size limit';
