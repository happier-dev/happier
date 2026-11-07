import { FilesystemDownloadOutputSchema, type FileDownloadResultV1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { PluginUiDownloadFileRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import { randomUUID } from '@/platform/randomUUID';
import { captureFilesystemTransferAccountScope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/filesystemTransferAccountScope';
import { resolveMachineCarrierRoute } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease';
import { downloadBulkPayloadViaDirectExportToDestination } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferExportDownload';
import { createPlatformDownloadFileSink } from '@/sync/runtime/files/platformDownloadFileSink';
import { shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { downloadWebFile } from '@/sync/runtime/files/downloadWebFile';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createPluginSurfaceHostApiError, readPluginSurfaceHostApiErrorPayload, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';
import type { PluginSurfaceContributedActionDescriptorResolver } from './pluginSurfaceActionDispatch';

export function createPluginSurfaceDownloadOwner(input: Readonly<{
    machineId: string; serverId?: string | null; lifetimeSignal: AbortSignal;
    isCurrent(): boolean; executeAction: PluginSurfaceHostApiMethodHandler;
    resolveContributedAction: PluginSurfaceContributedActionDescriptorResolver;
}>) {
    const lifetime = new AbortController();
    const retire = () => lifetime.abort();
    input.lifetimeSignal.addEventListener('abort', retire, { once: true });
    if (input.lifetimeSignal.aborted) retire();
    const downloadFile: PluginSurfaceHostApiMethodHandler = async (request, options) => {
        const parsed = PluginUiDownloadFileRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['download_request_invalid']);
        // prepareDownload is a Machine service. Pin the same admitted
        // declaration the ordinary dispatcher will recheck, never a Session's
        // context Machine or an Account/client executable with another origin.
        const action = input.resolveContributedAction(parsed.data.action);
        if (!action || action.execution.target !== 'daemon') return createPluginSurfaceHostApiError('unavailable', ['download_action_placement_unavailable']);
        const operation = mergeAbortSignals([lifetime.signal, options?.signal]);
        let account: Awaited<ReturnType<typeof captureFilesystemTransferAccountScope>> | undefined;
        let allocated: Awaited<ReturnType<typeof createPlatformDownloadFileSink>> | undefined;
        let retainDestination = false;
        const failure = (error: string, errorCode: string, status: 'failed' | 'cancelled' | 'unknown' = 'failed'): Extract<FileDownloadResultV1, { success: false }> =>
            ({ success: false, status, error, errorCode });
        const assertCurrent = () => {
            operation.signal.throwIfAborted();
            if (!input.isCurrent()) throw new Error('Download authority retired');
            account?.assertCurrent();
        };
        try {
            assertCurrent();
            account = await captureFilesystemTransferAccountScope(input.serverId, operation.signal);
            assertCurrent();
            const route = await resolveMachineCarrierRoute(input.machineId, account.serverId);
            assertCurrent();
            if (route.kind === 'unavailable') return failure(route.error, route.errorCode);
            const destinationId = randomUUID();
            const result = await input.executeAction({ ...request, method: 'executeAction',
                payload: { action: parsed.data.action, input: { ...parsed.data.input, destination: { destinationId } } } },
                { ...options, expectedContributedAction: action, signal: account.signal });
            const hostFailure = readPluginSurfaceHostApiErrorPayload(result);
            if (hostFailure) return failure(hostFailure.message ?? 'Download Action unavailable', hostFailure.code,
                hostFailure.code === 'timeout' ? 'unknown' : 'failed');
            const receipt = FilesystemDownloadOutputSchema.safeParse(result);
            if (!receipt.success) return failure('Download Action did not return an accepted transfer', 'download_not_accepted');
            if (!receipt.data.success) return receipt.data;
            if (receipt.data.status !== 'accepted' || receipt.data.destinationId !== destinationId || 'entryTree' in receipt.data) {
                return failure('Download Action did not accept the held destination', 'download_destination_mismatch');
            }
            // No platform allocation or read of the transfer capability precedes
            // exact destination and original Account/mount currentness checks.
            assertCurrent();
            const captured = account;
            const transfer = await downloadBulkPayloadViaDirectExportToDestination({ machineId: input.machineId,
                serverId: route.serverId, acceptedReceipt: receipt.data, signal: captured.signal,
                destination: {
                    writeBytes: async bytes => { assertCurrent(); if (!allocated) throw new Error('Download sink unavailable'); await allocated.sink.writeBytes(bytes); },
                    close: async () => { assertCurrent(); if (!allocated) throw new Error('Download sink unavailable'); await allocated.sink.close(); },
                    cleanup: async () => { await allocated?.sink.cleanup(); allocated = undefined; },
                },
                onInit: async init => { assertCurrent(); allocated = await createPlatformDownloadFileSink(init); assertCurrent(); },
                acquirePreparedCarrier: async ({ operationId }) => { assertCurrent(); return await route.acquire({
                    operationId, signal: captured.signal, accountLifetime: captured.accountLifetime }); },
                acquireCleanupCarrier: async ({ operationId }) => {
                    captured.assertAccountCurrent();
                    return await route.acquire({ operationId, accountLifetime: captured.accountOnlyLifetime });
                },
            });
            if (!transfer.ok) {
                // The incumbent receiver has already closed actual bytes when
                // its final ACK is uncertain. Never delete that physical effect.
                retainDestination = transfer.errorCode === 'indeterminate';
                return failure(transfer.error, transfer.errorCode ?? 'download_failed', retainDestination ? 'unknown'
                    : captured.signal.aborted ? 'cancelled' : 'failed');
            }
            assertCurrent();
            if (!allocated) return failure('Download sink unavailable', 'download_failed');
            if (allocated.kind === 'web') {
                const sink = allocated.sink;
                const file = await sink.getFile();
                assertCurrent();
                downloadWebFile(file, transfer.name, sink.cleanup);
                retainDestination = true;
            } else {
                const handoff = await shareNativeCacheFile({ fileUri: allocated.sink.fileUri, name: transfer.name, action: 'save',
                    isCurrent: () => input.isCurrent() && !captured.signal.aborted });
                if (handoff.status === 'canceled') return failure('Download cancelled', 'cancelled', 'cancelled');
                if (handoff.status === 'unavailable') return failure('Download destination unavailable', 'download_failed');
                retainDestination = handoff.retainCacheFile;
                if (handoff.completion !== 'confirmed') return failure('Download handoff could not be confirmed', 'indeterminate', 'unknown');
            }
            return { success: true, status: 'completed', transferId: receipt.data.prepared.transferId, destinationId,
                name: transfer.name, sizeBytes: transfer.sizeBytes, sha256: receipt.data.prepared.manifestHash.slice('sha256:'.length) };
        } catch (error) {
            return failure(error instanceof Error ? error.message : 'Download failed', 'download_failed',
                operation.signal.aborted || account?.signal.aborted ? 'cancelled' : 'failed');
        } finally {
            if (!retainDestination) await allocated?.sink.cleanup();
            account?.dispose(); operation.dispose();
        }
    };
    return { downloadFile, dispose() { retire(); input.lifetimeSignal.removeEventListener('abort', retire); } };
}
