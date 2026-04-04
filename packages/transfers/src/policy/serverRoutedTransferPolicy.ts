import {
    DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES,
    MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_HARD_MAX,
    MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
    normalizeMachineTransferServerRoutedMaxBytes,
    readMachineTransferServerRoutedMaxBytes,
    type FeaturesResponse,
} from '@happier-dev/protocol';

export function resolveServerRoutedTransferMaxBytesFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): number | null {
    const configured = normalizeMachineTransferServerRoutedMaxBytes(env[MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY]);
    const resolved = configured ?? DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES;
    return Math.min(resolved, MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_HARD_MAX);
}

export function resolveServerRoutedTransferMaxBytesFromFeatures(
    features: Pick<FeaturesResponse, 'capabilities'> | null | undefined,
): number | null {
    return readMachineTransferServerRoutedMaxBytes(features) ?? DEFAULT_MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES;
}

export function isServerRoutedTransferOverSizeLimit(
    sizeBytes: number,
    maxBytes: number | null,
): boolean {
    return typeof maxBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > maxBytes;
}
