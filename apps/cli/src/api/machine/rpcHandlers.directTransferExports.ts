import { ComposerContentHandleV1Schema, MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { PromptAssetExternalRefV1Schema } from '@happier-dev/protocol/prompts/library/promptAssetsV1';
import { PromptAssetScopeV1Schema } from '@happier-dev/protocol/prompts/library/promptAssetDescriptorsV1';
import { PromptRegistryConfiguredSourceV1Schema } from '@happier-dev/protocol/prompts/library/promptRegistriesV1';
import { WorkspaceSyncSeedExportPrepareV1Schema, WorkspaceSyncTargetConflictStageV1Schema, type WorkspaceSyncSeedExportPrepareV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ComposerContentHandleV1, PromptAssetReadRequest, PromptRegistryFetchItemRequestV1, TransferEndpointCandidate, WorkspaceSyncTargetConflictStageV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod';

import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

import type { RpcHandlerRegistrar } from '../rpc/types';
import type { PreparedFilesystemTransferScope } from '@/machines/transfer/preparedFilesystemTransferScope';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

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
        confinedToWorkingDirectory?: boolean;
    }>
    | Readonly<WorkspaceSyncSeedExportPrepareV1>
    | Readonly<{ t: 'workspace_sync_resolution_v1' } & WorkspaceSyncTargetConflictStageV1>
    | Readonly<{
        t: 'composer_media_stage_inspect_v1';
        handle: ComposerContentHandleV1;
        offset: number;
        maxBytes: number;
    }>;

const DirectTransferExportPrepareRequestSchema = z.union([
    z.object({
        t: z.literal('prompt_asset_download_v1'),
        assetTypeId: z.string().min(1),
        scope: asHostProtocolZod(PromptAssetScopeV1Schema),
        directory: z.string().min(1).nullable().optional(),
        externalRef: asHostProtocolZod(PromptAssetExternalRefV1Schema),
    }).strict(),
    z.object({
        t: z.literal('prompt_registry_download_v1'),
        sourceId: z.string().min(1),
        itemId: z.string().min(1),
        configuredSources: z.array(asHostProtocolZod(PromptRegistryConfiguredSourceV1Schema)).default([]),
    }).strict(),
    z.object({
        t: z.literal('workspace_file_download_v1'),
        workingDirectory: z.string().min(1),
        path: z.string().min(1),
        asZip: z.boolean(),
        confinedToWorkingDirectory: z.boolean().optional(),
    }).strict(),
    asHostProtocolZod(WorkspaceSyncSeedExportPrepareV1Schema),
    asHostProtocolZod(WorkspaceSyncTargetConflictStageV1Schema.extend({
        t: z.literal('workspace_sync_resolution_v1'),
    }).strict()),
    z.object({
        t: z.literal('composer_media_stage_inspect_v1'),
        handle: asHostProtocolZod(ComposerContentHandleV1Schema),
        offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        maxBytes: z.number().int().positive().max(MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1),
    }).strict(),
]);

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
        manifestHash?: string;
    }
    | {
        success: false;
        error: string;
        code?: string;
    }
>;

export function registerMachineDirectTransferExportRpcHandlers(params: Readonly<{
    admissionDrain?: Pick<DaemonAdmissionDrain, 'isQuiescing' | 'isFinalShutdown'>;
    rpcHandlerManager: RpcHandlerRegistrar;
    prepareExportSession: (input: DirectTransferExportPrepareRequest, filesystemScope?: PreparedFilesystemTransferScope) => Promise<Readonly<{
        transferId: string;
        expiresAt: number;
        endpointCandidates: readonly TransferEndpointCandidate[];
        name?: string;
        sizeBytes?: number;
        manifestHash?: string;
    }>>;
    releaseExportSession?: (transferId: string, filesystemScope?: PreparedFilesystemTransferScope | null) => Promise<void> | void;
}>): void {
    params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, async (data: unknown, context) => {
        const parsed = DirectTransferExportPrepareRequestSchema.safeParse(data);
        if (!parsed.success) {
            return { success: false, error: 'Invalid direct transfer export request' } satisfies DirectTransferExportPrepareResponse;
        }
        const request: DirectTransferExportPrepareRequest = parsed.data;
        if (context?.workspaceSyncSeedRouting && request.t !== 'workspace_sync_seed_v1') {
            return { success: false, error: 'Invalid workspace seed export purpose' } satisfies DirectTransferExportPrepareResponse;
        }
        if (params.admissionDrain?.isQuiescing()) {
            return { success: false, error: params.admissionDrain.isFinalShutdown()
                ? 'The daemon is shutting down.' : 'The daemon is draining.' } satisfies DirectTransferExportPrepareResponse;
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
                ...(request.t === 'workspace_sync_resolution_v1'
                    && error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                    ? { code: error.code }
                    : {}),
            } satisfies DirectTransferExportPrepareResponse;
        }
    });

    if (params.releaseExportSession) {
        params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE, async (data: unknown) => {
            const transferId = data && typeof data === 'object'
                ? (data as { transferId?: unknown }).transferId
                : null;
            if (
                typeof transferId !== 'string'
                || transferId.length === 0
                || Object.keys(data as object).length !== 1
            ) {
                return { success: false, error: 'Invalid direct transfer export release request' } as const;
            }
            try {
                await params.releaseExportSession?.(transferId, null);
                return { success: true } as const;
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Direct transfer export release failed',
                } as const;
            }
        });
    }
}
