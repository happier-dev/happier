import { FilesystemCopyOutputSchema, FilesystemDownloadOutputSchema, type FilesystemPreparedCopyInput, type FilesystemTargetCopyInput, type FilesystemUploadOutput, type FilesystemCopyOutput } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { encodeBase64 } from '@/encryption/base64';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { callFilesystemTransferAction } from './filesystemTransferActionClient';
import { randomUUID } from '@/platform/randomUUID';
import { downloadBulkPayloadViaDirectExportToDestination, completePreparedFilesystemExport } from './directTransferExportDownload';
import { abortOwnedDirectImportSession, finalizeDirectImportSession, isDirectImportTerminalFinalizeErrorCode,
    prepareDirectImportSession, sendDirectImportChunk, type PreparedDirectImportSession,
    resolveDirectImportCarrierRequest, type DirectTransferImportFinalizeResponse } from './directTransferImportClient';
import type { MachineCarrierHttpLease } from './machineCarrierHttpLease';
import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

type CopyAccount = Pick<Awaited<ReturnType<typeof captureLazyActionAccountContext>>, 'accountId' | 'accountLifetime' | 'accountOnlyLifetime' | 'assertCurrent' | 'assertAccountCurrent'>;
type AcquireCopyCarrier = (prepared: Readonly<{ operationId: string; signal?: AbortSignal; accountLifetime?: ServerAccountScopeLifetime }>) => Promise<MachineCarrierHttpLease | null>;
type CopyParams = Readonly<{
    input: FilesystemPreparedCopyInput | FilesystemTargetCopyInput;
    acquireSourceCarrier: (prepared: Readonly<{ operationId: string; signal?: AbortSignal; accountLifetime?: ServerAccountScopeLifetime }>) => Promise<MachineCarrierHttpLease | null>;
    acquireDestinationCarrier: (prepared: Readonly<{ operationId: string; signal?: AbortSignal; accountLifetime?: ServerAccountScopeLifetime }>) => Promise<MachineCarrierHttpLease | null>;
    sourceAccount?: CopyAccount;
    destinationAccount?: CopyAccount;
    signal?: AbortSignal | null;
}>;
type OwnedCopyParams = CopyParams & Readonly<{
    acquireSourceCleanupCarrier: AcquireCopyCarrier;
    acquireDestinationCleanupCarrier: AcquireCopyCarrier;
}>;

/** Both exact Account lifetimes stay mounted through source custody and write approval. */
export async function copyPreparedFilesystemFile(params: CopyParams): Promise<FilesystemCopyOutput> {
    if (params.input.kind === 'prepared_transfer' && params.input.source.kind === 'entry_tree') {
        return { success: false, status: 'failed', error: 'The original prepared entry export capability is required.',
            errorCode: 'filesystem_transfer_custody_required' };
    }
    const retirement = new AbortController();
    const subscriptions = [params.sourceAccount, params.destinationAccount].flatMap(account => account
        ? [account.accountLifetime.onRetire(() => retirement.abort())] : []);
    const cancellation = mergeAbortSignals([params.signal ?? undefined, retirement.signal]);
    try {
        params.sourceAccount?.assertCurrent(); params.destinationAccount?.assertCurrent();
        const scoped: OwnedCopyParams = { ...params, signal: cancellation.signal,
            acquireSourceCarrier: async (prepared: Readonly<{ operationId: string }>) => {
                params.sourceAccount?.assertCurrent();
                return await params.acquireSourceCarrier({ ...prepared, signal: cancellation.signal, accountLifetime: params.sourceAccount?.accountLifetime });
            },
            acquireDestinationCarrier: async (prepared: Readonly<{ operationId: string }>) => {
                params.destinationAccount?.assertCurrent();
                return await params.acquireDestinationCarrier({ ...prepared, signal: cancellation.signal, accountLifetime: params.destinationAccount?.accountLifetime });
            },
            acquireSourceCleanupCarrier: async prepared => {
                params.sourceAccount?.assertAccountCurrent();
                return await params.acquireSourceCarrier({ ...prepared, accountLifetime: params.sourceAccount?.accountOnlyLifetime });
            },
            acquireDestinationCleanupCarrier: async prepared => {
                params.destinationAccount?.assertAccountCurrent();
                return await params.acquireDestinationCarrier({ ...prepared, accountLifetime: params.destinationAccount?.accountOnlyLifetime });
            } };
        return params.input.kind === 'target_copy' || params.input.source.kind === 'entry_tree'
            ? await copyPreparedFilesystemEntry(scoped) : await copyPreparedFilesystemFileBytes(scoped);
    } catch (error) {
        return { success: false, status: cancellation.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Copy custody is unavailable', errorCode: 'action_account_scope_changed' };
    } finally { cancellation.dispose(); for (const subscription of subscriptions) subscription.dispose(); }
}

async function copyPreparedFilesystemFileBytes(params: OwnedCopyParams): Promise<FilesystemUploadOutput> {
    const input = params.input;
    let session: PreparedDirectImportSession | undefined;
    let buffer: Uint8Array | undefined;
    let bufferedBytes = 0;
    let receivedBytes = 0;
    let index = 0;
    let retainImport = false;
    let finalized: DirectTransferImportFinalizeResponse | undefined;
    let sourceId = input.kind === 'prepared_transfer' ? input.source.sourceId : randomUUID();
    const abort = async () => {
        if (!session || retainImport) return;
        let cleanupCarrier: MachineCarrierHttpLease | null = null;
        try {
            let preparedSession: Pick<PreparedDirectImportSession, 'baseUrls' | 'request'> = session;
            if (params.signal?.aborted) {
                cleanupCarrier = await params.acquireDestinationCleanupCarrier({ operationId: session.uploadId });
                if (!cleanupCarrier) return;
                const endpoint = resolveDirectImportCarrierRequest({ endpointUrl: session.baseUrls[0]!, carrier: cleanupCarrier });
                preparedSession = { baseUrls: [endpoint.url], request: endpoint.request };
            }
            await abortOwnedDirectImportSession({ machineId: input.destination.machineId,
                serverId: input.destination.serverId, accountId: params.destinationAccount?.accountId, uploadId: session.uploadId,
                preparedSession, filesystemRootPath: input.destination.rootPath });
        } finally { await cleanupCarrier?.release(); }
    };
    const sendBufferedChunk = async () => {
        if (!session || !buffer) throw new Error('Copy destination custody is unavailable');
        const encrypted = await createEncryptedTransferChunkEnvelope({ transferId: session.uploadId, sequence: index,
            payload: buffer.subarray(0, bufferedBytes), recipientPublicKeyBase64: session.recipientPublicKeyBase64 });
        const response = await sendDirectImportChunk({ baseUrl: session.baseUrls[0]!, index, ...encrypted,
            request: session.request, signal: params.signal });
        if (!response.success) throw new Error(response.error);
        index += 1;
        bufferedBytes = 0;
    };
    try {
        const copied = await downloadBulkPayloadViaDirectExportToDestination({ machineId: input.source.machineId,
            serverId: input.source.serverId, accountId: params.sourceAccount?.accountId, request: { t: 'workspace_file_download_v1', workingDirectory: input.source.rootPath,
                path: input.source.path, asZip: false }, signal: params.signal, acquirePreparedCarrier: params.acquireSourceCarrier,
            acquireCleanupCarrier: params.acquireSourceCleanupCarrier,
            onInit: async ({ sizeBytes, manifestHash }) => {
                if (!manifestHash || (input.kind === 'prepared_transfer' && (sizeBytes !== input.source.sizeBytes
                    || manifestHash.toLowerCase() !== `sha256:${input.source.sha256.toLowerCase()}`))) {
                    return { success: false, error: 'Prepared copy source identity does not match the admitted source' };
                }
                const source = input.kind === 'prepared_transfer' ? input.source : { ...input.source, kind: 'file' as const,
                    sourceId, sizeBytes, sha256: manifestHash.slice('sha256:'.length) };
                sourceId = source.sourceId;
                const prepared = await prepareDirectImportSession({ machineId: input.destination.machineId, serverId: input.destination.serverId,
                    accountId: params.destinationAccount?.accountId,
                    request: { t: 'session_file_upload_v1', workingDirectory: input.destination.rootPath, path: input.destination.path,
                        sizeBytes, overwrite: input.overwrite, sha256: source.sha256 },
                    filesystemCopyInput: { kind: 'prepared_transfer', source, destination: input.destination,
                        overwrite: input.overwrite, recursive: input.recursive },
                    signal: params.signal, acquirePreparedCarrier: params.acquireDestinationCarrier });
                if (!prepared.success) return prepared;
                session = prepared.session;
                // This is the receiver's established chunk budget, not a whole-file buffer.
                buffer = new Uint8Array(session.chunkSizeBytes);
            },
            destination: {
                writeBytes: async bytes => {
                    if (!session || !buffer) throw new Error('Copy destination custody is unavailable');
                    receivedBytes += bytes.byteLength;
                    if (receivedBytes > session.expectedSizeBytes) throw new Error('Copy exceeded its admitted source size');
                    let offset = 0;
                    while (offset < bytes.byteLength) {
                        const length = Math.min(buffer.byteLength - bufferedBytes, bytes.byteLength - offset);
                        buffer.set(bytes.subarray(offset, offset + length), bufferedBytes);
                        offset += length;
                        bufferedBytes += length;
                        if (bufferedBytes === buffer.byteLength) await sendBufferedChunk();
                    }
                },
                close: async () => {
                    if (!session || receivedBytes !== session.expectedSizeBytes) throw new Error('Copy source is incomplete');
                    if (bufferedBytes > 0 || index === 0) await sendBufferedChunk();
                    finalized = await finalizeDirectImportSession({ baseUrl: session.baseUrls[0]!, request: session.request, signal: params.signal });
                    retainImport = finalized.success || isDirectImportTerminalFinalizeErrorCode(finalized.errorCode);
                    if (!finalized.success) throw new Error(finalized.error);
                },
                cleanup: abort,
            },
        });
        if (!copied.ok) return { success: false, status: retainImport ? 'unknown' : params.signal?.aborted ? 'cancelled' : 'failed',
            error: copied.error, ...(retainImport ? { errorCode: 'indeterminate' } : copied.errorCode ? { errorCode: copied.errorCode } : {}) };
        if (!session || !finalized?.success) throw new Error('Copy completion is unavailable');
        return { success: true, status: 'completed', transferId: session.uploadId, sourceId,
            path: finalized.finalized.path, sizeBytes: finalized.finalized.sizeBytes, sha256: finalized.sha256 };
    } catch (error) {
        return { success: false, status: retainImport ? 'unknown' : params.signal?.aborted ? 'cancelled' : 'failed',
            error: error instanceof Error ? error.message : 'Copy failed', ...(retainImport ? { errorCode: 'indeterminate' } : {}) };
    } finally {
        try { await abort(); } finally { await session?.releaseCarrier?.(); }
    }
}

async function copyPreparedFilesystemEntry(params: OwnedCopyParams): Promise<FilesystemCopyOutput> {
    const input = params.input;
    const destinationId = randomUUID();
    let source: Extract<import('@happier-dev/protocol/actions/filesystemActionFamily').FilesystemDownloadOutput, { success: true; status: 'accepted' }> | undefined;
    let accepted: Extract<FilesystemCopyOutput, { success: true; status: 'accepted' }> | undefined;
    let retainImports = false;
    let sourceClosed = false;
    try {
        params.sourceAccount?.assertCurrent(); params.destinationAccount?.assertCurrent();
        const receipt = FilesystemDownloadOutputSchema.parse(await callFilesystemTransferAction({ actionId: 'daemon.filesystem.download',
            machineId: input.source.machineId, serverId: input.source.serverId, accountId: params.sourceAccount?.accountId, signal: params.signal,
            input: { rootPath: input.source.rootPath, path: input.source.path, asZip: false, format: 'entry_tree', destination: { destinationId } } }));
        if (!receipt.success || receipt.status !== 'accepted') return receipt;
        source = receipt;
        if (!('entryTree' in receipt) || receipt.destinationId !== destinationId) throw new Error('Entry source custody is unavailable');
        if (receipt.entryTree.expectation.kind === 'missing') throw new Error('Copy source is missing');
        if (receipt.entryTree.expectation.kind === 'directory' && !input.recursive) throw new Error('A directory copy requires recursive=true');
        if (input.kind === 'prepared_transfer' && (input.source.kind !== 'entry_tree' || input.source.sizeBytes !== receipt.prepared.sizeBytes
            || `sha256:${input.source.sha256.toLowerCase()}` !== receipt.prepared.manifestHash.toLowerCase()
            || JSON.stringify(input.source.entryTree) !== JSON.stringify(receipt.entryTree))) throw new Error('Prepared entry source identity changed');
        const preparedSource = { ...input.source, kind: 'entry_tree' as const, sourceId: input.kind === 'prepared_transfer' ? input.source.sourceId : receipt.prepared.transferId,
            sizeBytes: receipt.prepared.sizeBytes, sha256: receipt.prepared.manifestHash.slice('sha256:'.length), entryTree: receipt.entryTree };
        params.destinationAccount?.assertCurrent();
        const admission = FilesystemCopyOutputSchema.parse(await callFilesystemTransferAction({ actionId: 'daemon.filesystem.copy',
            machineId: input.destination.machineId, serverId: input.destination.serverId, accountId: params.destinationAccount?.accountId,
            signal: params.signal, input: { kind: 'prepared_transfer', source: preparedSource, destination: input.destination, overwrite: input.overwrite, recursive: input.recursive } }));
        if (!admission.success || !('status' in admission) || admission.status !== 'accepted') return admission;
        accepted = admission;
        if (!('manifest' in admission.prepared) || admission.sourceId !== preparedSource.sourceId) throw new Error('Entry destination custody is unavailable');
        const payloads = [{ transferId: receipt.entryTree.operationId, sizeBytes: receipt.prepared.sizeBytes, manifestHash: receipt.prepared.manifestHash }, ...receipt.entryTree.blobs];
        const imports = [{ transferId: receipt.entryTree.operationId, prepared: admission.prepared.manifest }, ...admission.prepared.blobs];
        if (imports.length !== payloads.length || new Set(imports.map(record => record.transferId)).size !== payloads.length) throw new Error('Entry import commitments changed');
        for (const record of imports) {
            const descriptor = payloads.find(payload => payload.transferId === record.transferId);
            if (!descriptor || descriptor.sizeBytes !== record.prepared.expectedSizeBytes) throw new Error('Entry payload identity changed');
            params.sourceAccount?.assertCurrent(); params.destinationAccount?.assertCurrent();
            const preparation = await prepareDirectImportSession({ machineId: input.destination.machineId, serverId: input.destination.serverId,
                accountId: params.destinationAccount?.accountId, preparedImport: record.prepared,
                request: { t: 'session_file_upload_v1', workingDirectory: input.destination.rootPath, path: input.destination.path,
                    sizeBytes: descriptor.sizeBytes, sha256: descriptor.manifestHash.slice('sha256:'.length), overwrite: input.overwrite },
                signal: params.signal, acquirePreparedCarrier: params.acquireDestinationCarrier });
            if (!preparation.success) throw Object.assign(new Error(preparation.error), { errorCode: preparation.errorCode });
            const session = preparation.session;
            const buffer = new Uint8Array(session.chunkSizeBytes);
            let buffered = 0; let received = 0; let sequence = 0;
            const flush = async () => {
                const encrypted = await createEncryptedTransferChunkEnvelope({ transferId: session.uploadId, sequence,
                    payload: buffer.subarray(0, buffered), recipientPublicKeyBase64: session.recipientPublicKeyBase64 });
                const result = await sendDirectImportChunk({ baseUrl: session.baseUrls[0]!, index: sequence, ...encrypted, request: session.request, signal: params.signal });
                if (!result.success) throw new Error(result.error);
                sequence += 1; buffered = 0;
            };
            const preparedExport = { ...receipt.prepared, transferId: descriptor.transferId, sizeBytes: descriptor.sizeBytes, manifestHash: descriptor.manifestHash,
                endpointCandidates: receipt.prepared.endpointCandidates.map(candidate => {
                    const url = new URL(candidate.url); const index = url.pathname.lastIndexOf('/');
                    url.pathname = `${url.pathname.slice(0, index + 1)}${encodeBase64(new TextEncoder().encode(descriptor.transferId), 'base64url')}`;
                    return { ...candidate, url: url.toString() };
                }) };
            try {
                const streamed = await downloadBulkPayloadViaDirectExportToDestination({ machineId: input.source.machineId, serverId: input.source.serverId,
                    accountId: params.sourceAccount?.accountId, preparedExport, request: { t: 'workspace_file_download_v1', workingDirectory: input.source.rootPath, path: input.source.path, asZip: false },
                    signal: params.signal, acquirePreparedCarrier: params.acquireSourceCarrier,
                    destination: { writeBytes: async bytes => {
                        received += bytes.byteLength;
                        if (received > descriptor.sizeBytes) throw new Error('Entry payload exceeds admitted size');
                        let offset = 0;
                        while (offset < bytes.byteLength) { const length = Math.min(buffer.byteLength - buffered, bytes.byteLength - offset);
                            buffer.set(bytes.subarray(offset, offset + length), buffered); offset += length; buffered += length;
                            if (buffered === buffer.byteLength) await flush(); }
                    }, close: async () => {
                        if (received !== descriptor.sizeBytes) throw new Error('Entry payload is incomplete');
                        if (buffered > 0 || sequence === 0) await flush();
                        const finalized = await finalizeDirectImportSession({ baseUrl: session.baseUrls[0]!, request: session.request, signal: params.signal });
                        if (!finalized.success) { retainImports = isDirectImportTerminalFinalizeErrorCode(finalized.errorCode);
                            throw Object.assign(new Error(finalized.error), { errorCode: finalized.errorCode }); }
                    } } });
                if (!streamed.ok) throw Object.assign(new Error(streamed.error), { errorCode: streamed.errorCode });
            } catch (error) {
                if (!retainImports) await abortOwnedDirectImportSession({ machineId: input.destination.machineId, serverId: input.destination.serverId,
                    accountId: params.destinationAccount?.accountId, uploadId: session.uploadId, filesystemRootPath: input.destination.rootPath,
                    preparedSession: session }).catch(() => undefined);
                throw error;
            } finally { await Promise.resolve(session.releaseCarrier?.()).catch(() => undefined); }
        }
        retainImports = true;
        sourceClosed = true;
        if (!await completePreparedFilesystemExport({ prepared: receipt.prepared, destinationId, acquirePreparedCarrier: params.acquireSourceCarrier })) {
            return { success: false, status: 'unknown', error: 'Source completion could not be confirmed', errorCode: 'indeterminate' };
        }
        params.destinationAccount?.assertCurrent();
        const terminal = ActionOperationGetV1ResponseSchema.parse(await callGuardedMachineRpcWithPolicy({ machineId: input.destination.machineId,
            serverId: input.destination.serverId, accountId: params.destinationAccount?.accountId, method: ACTION_OPERATION_RPC_METHODS_V2.get,
            payload: { operationId: admission.operationId, waitForTerminal: true }, operationTimeoutMs: null, signal: params.signal ?? undefined }));
        if (terminal.kind === 'not_found' || terminal.operation.state === 'running' || terminal.operation.state === 'accepted') return { success: false, status: 'unknown', error: 'Copy native outcome is unconfirmed', errorCode: 'indeterminate' };
        if (terminal.operation.state === 'succeeded') return FilesystemCopyOutputSchema.parse(terminal.operation.result);
        return { success: false, status: terminal.operation.state === 'cancelled' ? 'cancelled' : 'failed', error: terminal.operation.error?.error ?? 'Copy failed', errorCode: terminal.operation.error?.errorCode ?? 'cancelled' };
    } catch (error) {
        return { success: false, status: retainImports ? 'unknown' : params.signal?.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Copy failed',
            ...(retainImports ? { errorCode: 'indeterminate' } : error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? { errorCode: error.errorCode } : {}) };
    } finally {
        if (source && !sourceClosed) await completePreparedFilesystemExport({ prepared: source.prepared, destinationId,
            failure: { error: 'The containing copy did not complete', ...(params.signal?.aborted ? { errorCode: 'cancelled' } : {}) },
            acquirePreparedCarrier: params.acquireSourceCleanupCarrier }).catch(() => undefined);
        if (accepted && !retainImports) { const records = 'manifest' in accepted.prepared ? [accepted.prepared.manifest, ...accepted.prepared.blobs.map(record => record.prepared)] : [accepted.prepared];
            await Promise.all(records.map(async record => {
                const prepared = await prepareDirectImportSession({ machineId: input.destination.machineId, serverId: input.destination.serverId,
                    accountId: params.destinationAccount?.accountId, preparedImport: record, request: { t: 'session_file_upload_v1',
                        workingDirectory: input.destination.rootPath, path: input.destination.path, sizeBytes: record.expectedSizeBytes, overwrite: input.overwrite },
                    acquirePreparedCarrier: params.acquireDestinationCleanupCarrier });
                if (!prepared.success) return;
                try { await abortOwnedDirectImportSession({ machineId: input.destination.machineId, serverId: input.destination.serverId,
                    accountId: params.destinationAccount?.accountId, uploadId: record.uploadId, filesystemRootPath: input.destination.rootPath,
                    preparedSession: prepared.session }); }
                finally { await Promise.resolve(prepared.session.releaseCarrier?.()).catch(() => undefined); }
            }).map(attempt => attempt.catch(() => undefined))); }
    }
}
