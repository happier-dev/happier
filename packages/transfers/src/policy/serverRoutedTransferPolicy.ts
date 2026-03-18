import {
    MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
    normalizeMachineTransferServerRoutedMaxBytes,
    readMachineTransferServerRoutedMaxBytes,
    type FeaturesResponse,
} from '@happier-dev/protocol';

export function resolveServerRoutedTransferMaxBytesFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): number | null {
    return normalizeMachineTransferServerRoutedMaxBytes(env[MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY]);
}

export function resolveServerRoutedTransferMaxBytesFromFeatures(
    features: Pick<FeaturesResponse, 'capabilities'> | null | undefined,
): number | null {
    return readMachineTransferServerRoutedMaxBytes(features);
}

export function isServerRoutedTransferOverSizeLimit(
    sizeBytes: number,
    maxBytes: number | null,
): boolean {
    return typeof maxBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > maxBytes;
}
