import {
    MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
    normalizeMachineTransferServerRoutedMaxBytes,
    readMachineTransferServerRoutedMaxBytes,
    type FeaturesResponse,
} from '@happier-dev/protocol';

// Server-routed transfers must be bounded even when the env/capability is missing. The server
// advertises a default capability, but CLI/daemon processes may also need a safe fallback.
const DEFAULT_SERVER_ROUTED_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const SERVER_ROUTED_TRANSFER_MAX_BYTES_HARD_MAX = 8 * 1024 * 1024 * 1024; // 8 GiB

export function resolveServerRoutedTransferMaxBytesFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): number | null {
    const configured = normalizeMachineTransferServerRoutedMaxBytes(env[MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY]);
    const resolved = configured ?? DEFAULT_SERVER_ROUTED_TRANSFER_MAX_BYTES;
    return Math.min(resolved, SERVER_ROUTED_TRANSFER_MAX_BYTES_HARD_MAX);
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
