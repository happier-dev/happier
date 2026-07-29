import {
    isSafeDirectTransferEndpointCandidate,
    type TransferEndpointCandidate,
} from '@happier-dev/protocol';

import { isDirectPeerTransferProtocolError } from './directPeerTransport';

const DEFAULT_DIRECT_PEER_WORKSPACE_RETRY_ATTEMPTS = 5;
const DEFAULT_DIRECT_PEER_WORKSPACE_RETRY_DELAY_MS = 125;

export async function requestDirectPeerTransferToFileWithRetry<TResult>(params: Readonly<{
    requestTransferToFile: (input: Readonly<{
        transferId: string;
        endpointCandidates: readonly TransferEndpointCandidate[];
        destinationPath: string;
        expectedSizeBytes?: number;
        expectedManifestHash?: string;
        openBody?: unknown;
        timeoutMs?: number;
    }>) => Promise<TResult>;
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    destinationPath: string;
    expectedSizeBytes?: number;
    expectedManifestHash?: string;
    openBody?: unknown;
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelayMs?: number;
    onRetry?: () => Promise<void> | void;
}>): Promise<TResult> {
    const maxAttempts =
        typeof params.maxAttempts === 'number' && params.maxAttempts > 0
            ? Math.floor(params.maxAttempts)
            : DEFAULT_DIRECT_PEER_WORKSPACE_RETRY_ATTEMPTS;
    const retryDelayMs =
        typeof params.retryDelayMs === 'number' && params.retryDelayMs >= 0
            ? Math.floor(params.retryDelayMs)
            : DEFAULT_DIRECT_PEER_WORKSPACE_RETRY_DELAY_MS;

    let lastError: unknown = null;
    const endpointCandidates = params.endpointCandidates.filter(isSafeDirectTransferEndpointCandidate);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await params.requestTransferToFile({
                transferId: params.transferId,
                endpointCandidates,
                destinationPath: params.destinationPath,
                ...(typeof params.expectedSizeBytes === 'number'
                    ? { expectedSizeBytes: params.expectedSizeBytes }
                    : {}),
                ...(typeof params.expectedManifestHash === 'string'
                    ? { expectedManifestHash: params.expectedManifestHash }
                    : {}),
                ...(params.openBody !== undefined ? { openBody: params.openBody } : {}),
                ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
            });
        } catch (error) {
            lastError = error;
            if (isDirectPeerTransferProtocolError(error) || attempt === maxAttempts) {
                throw error;
            }

            await params.onRetry?.();
            await new Promise<void>((resolve) => {
                setTimeout(resolve, retryDelayMs * attempt);
            });
        }
    }

    throw lastError instanceof Error ? lastError : new Error(`Direct peer transfer failed for ${params.transferId}`);
}
