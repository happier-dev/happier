import { ComposerContentHandleV1Schema, MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { FoundSkillDownloadRequestV1Schema, type FoundSkillDownloadRequestV1 } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import type { RegistryDownloadRequestV1 } from '@happier-dev/protocol/registries';
import { DaemonPluginUiArtifactBytesReadRequestSchema, type DaemonPluginUiArtifactBytesReadRequest } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { WorkspaceSyncSeedExportPrepareV1Schema, WorkspaceSyncTargetConflictStageV1Schema, type WorkspaceSyncSeedExportPrepareV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ComposerContentHandleV1, TransferEndpointCandidate, WorkspaceSyncTargetConflictStageV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod/mini';
import { extend } from 'zod/mini';

import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

import type { RpcHandlerRegistrar, RpcHandlerContext } from '../rpc/types';
import { readFilesystemTransferErrorCode, type PreparedFilesystemTransferScope } from '@/machines/transfer/preparedFilesystemTransferScope';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import type { FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';

export type DirectTransferExportPrepareRequest =
    | Readonly<{
        t: 'plugin_ui_artifact_download_v1';
        request: DaemonPluginUiArtifactBytesReadRequest;
    }>
    | Readonly<{
        t: 'prompt_asset_download_v1';
    } & FoundSkillDownloadRequestV1>
    | Readonly<{
        t: 'prompt_registry_download_v1';
    } & RegistryDownloadRequestV1>
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
    z.strictObject({
        t: z.literal('plugin_ui_artifact_download_v1'),
        request: asHostProtocolZod(DaemonPluginUiArtifactBytesReadRequestSchema),
    }),
    asHostProtocolZod(extend(FoundSkillDownloadRequestV1Schema, { t: z.literal('prompt_asset_download_v1') })),
    z.strictObject({
        t: z.literal('prompt_registry_download_v1'),
        sourceId: z.string().check(z.minLength(1)),
        kind: z.literal('skill'),
        itemId: z.string(),
        version: z.string().check(z.minLength(1)),
    }),
    z.strictObject({
        t: z.literal('workspace_file_download_v1'),
        workingDirectory: z.string().check(z.minLength(1)),
        path: z.string().check(z.minLength(1)),
        asZip: z.boolean(),
        confinedToWorkingDirectory: z.optional(z.boolean()),
    }),
    asHostProtocolZod(WorkspaceSyncSeedExportPrepareV1Schema),
    asHostProtocolZod(extend(WorkspaceSyncTargetConflictStageV1Schema, {
        t: z.literal('workspace_sync_resolution_v1'),
    })),
    z.strictObject({
        t: z.literal('composer_media_stage_inspect_v1'),
        handle: asHostProtocolZod(ComposerContentHandleV1Schema),
        offset: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
        maxBytes: z.number().check(z.int(), z.positive(), z.maximum(MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1)),
    }),
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
        errorCode?: string;
    }
>;

export function registerMachineDirectTransferExportRpcHandlers(params: Readonly<{
    admissionDrain?: Pick<DaemonAdmissionDrain, 'isQuiescing' | 'isFinalShutdown'>;
    rpcHandlerManager: RpcHandlerRegistrar;
    effectAdmission?: FilesystemEffectAdmission;
    prepareExportSession: (input: DirectTransferExportPrepareRequest, filesystemScope?: PreparedFilesystemTransferScope, context?: RpcHandlerContext) => Promise<Readonly<{
        transferId: string;
        expiresAt: number;
        endpointCandidates: readonly TransferEndpointCandidate[];
        name?: string;
        sizeBytes?: number;
        manifestHash?: string;
    }>>;
    releaseExportSession?: (transferId: string, filesystemScope?: PreparedFilesystemTransferScope | null, context?: RpcHandlerContext) => Promise<void> | void;
}>): void {
    params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, async (data: unknown, context) => {
        const parsed = DirectTransferExportPrepareRequestSchema.safeParse(data);
        if (!parsed.success) {
            return { success: false, error: 'Invalid direct transfer export request' } satisfies DirectTransferExportPrepareResponse;
        }
        const request: DirectTransferExportPrepareRequest = parsed.data;
        if (request.t === 'workspace_file_download_v1') {
            const failure = await params.effectAdmission?.rpc(context);
            if (failure) return { success: false, ...failure, code: failure.errorCode } satisfies DirectTransferExportPrepareResponse;
        }
        if (context?.workspaceSyncSeedRouting && request.t !== 'workspace_sync_seed_v1') {
            return { success: false, error: 'Invalid workspace seed export purpose' } satisfies DirectTransferExportPrepareResponse;
        }
        if (params.admissionDrain?.isQuiescing()) {
            return { success: false, error: params.admissionDrain.isFinalShutdown()
                ? 'The daemon is shutting down.' : 'The daemon is draining.' } satisfies DirectTransferExportPrepareResponse;
        }

        try {
            const prepared = context
                ? await params.prepareExportSession(request, undefined, context)
                : await params.prepareExportSession(request);
            return {
                success: true,
                ...prepared,
            } satisfies DirectTransferExportPrepareResponse;
        } catch (error) {
            const errorCode = readFilesystemTransferErrorCode(error, '');
            if (errorCode === 'filesystem_identity_custody_unavailable') return {
                success: false, error: 'Direct transfer export is unavailable', errorCode, code: errorCode,
            } satisfies DirectTransferExportPrepareResponse;
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Direct transfer export prepare failed',
                ...((request.t === 'workspace_sync_resolution_v1' || request.t === 'prompt_asset_download_v1')
                    && error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                    ? { code: error.code }
                    : {}),
            } satisfies DirectTransferExportPrepareResponse;
        }
    });

    if (params.releaseExportSession) {
        params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE, async (data: unknown, context) => {
            const failure = await params.effectAdmission?.rpc(context);
            if (failure) return { success: false, ...failure };
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
                if (context) await params.releaseExportSession?.(transferId, null, context);
                else await params.releaseExportSession?.(transferId, null);
                return { success: true } as const;
            } catch (error) {
                const errorCode = readFilesystemTransferErrorCode(error, '');
                if (errorCode === 'filesystem_identity_custody_unavailable') return {
                    success: false, error: 'Direct transfer export is unavailable', errorCode,
                } as const;
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Direct transfer export release failed',
                } as const;
            }
        });
    }
}
