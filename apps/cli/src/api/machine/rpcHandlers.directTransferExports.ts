import type {
    PromptAssetReadRequest,
    PromptRegistryFetchItemRequestV1,
    TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

export type DirectTransferExportPrepareRequest =
    | Readonly<{
        t: 'prompt_asset_download_v1';
    } & PromptAssetReadRequest>
    | Readonly<{
        t: 'prompt_registry_download_v1';
    } & PromptRegistryFetchItemRequestV1>
    | Readonly<{
        t: 'workspace_file_download_v1';
        workingDirectory: string;
        path: string;
        asZip: boolean;
    }>;

type DirectTransferExportPrepareResponse = Readonly<
    | {
        success: true;
        transferId: string;
        expiresAt: number;
        endpointCandidates: readonly TransferEndpointCandidate[];
    }
    | {
        success: true;
        transferId: string;
        expiresAt: number;
        endpointCandidates: readonly TransferEndpointCandidate[];
        name: string;
        sizeBytes: number;
    }
    | {
        success: false;
        error: string;
    }
>;

export function registerMachineDirectTransferExportRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcHandlerManager;
    prepareExportSession: (input: DirectTransferExportPrepareRequest) => Promise<Readonly<{
        transferId: string;
        expiresAt: number;
        endpointCandidates: readonly TransferEndpointCandidate[];
        name?: string;
        sizeBytes?: number;
    }>>;
}>): void {
    params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, async (data: unknown) => {
        const request = data as DirectTransferExportPrepareRequest | null;
        if (!request || typeof request !== 'object') {
            return { success: false, error: 'Invalid direct transfer export request' } satisfies DirectTransferExportPrepareResponse;
        }

        try {
            const prepared = await params.prepareExportSession(request);
            return {
                success: true,
                ...prepared,
            } satisfies DirectTransferExportPrepareResponse;
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Direct transfer export prepare failed',
            } satisfies DirectTransferExportPrepareResponse;
        }
    });
}
