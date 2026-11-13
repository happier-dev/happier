import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PreparedTransferRpcResponseV1Schema } from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { TransferChunkEnvelopeSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { registerTransferDownloadRpcHandlers } from '@/transfers/rpc/registerTransferDownloadRpcHandlers';
import { acquireDeploymentRestoreUpload } from '@/transfers/targets/deploymentRestoreUpload';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { prepareWorkspaceFileExport } from '@/machines/transfer/prepareWorkspaceFileExport';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from './rpcHandlers';

it('keeps restore upload custody and raw downloads when the prepared carrier registers the same phase methods', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-raw-prepared-rpc-seam-'));
  const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
  const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
  const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
  const rawTransferHandlers = new Map<string, RpcHandler<unknown, unknown>>();
  const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) {
    rawTransferHandlers.set(method, handler as RpcHandler<unknown, unknown>);
    manager.registerHandler(method, handler);
  } };
  // This host-owned registration fixes the requester before the finite upload;
  // crypto, transfer storage, completion and the full Machine registration stay real.
  registerTransferUploadRpcHandlers(registrar, { workingDirectory: directory, store, requesterAccountId: 'account' });
  registerTransferDownloadRpcHandlers(registrar, { workingDirectory: directory, store });
  const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
    spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable in transfer test' }),
    stopSession: async () => true, requestShutdown() {},
    preparedMachineTransfer: { request: lifecycle.requestPreparedTransfer, rawTransferHandlers },
  } });
  try {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const opened: unknown = await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
      { t: 'deployment_restore_upload_v1', environmentId: 'environment', sizeBytes: bytes.length });
    if (!opened || typeof opened !== 'object' || !('uploadId' in opened) || typeof opened.uploadId !== 'string'
      || !('recipientPublicKeyBase64' in opened) || typeof opened.recipientPublicKeyBase64 !== 'string') throw new Error('Restore upload was not opened');
    const chunk = createEncryptedTransferChunkEnvelope({ transferId: opened.uploadId, sequence: 0,
      payload: bytes, recipientPublicKeyBase64: opened.recipientPublicKeyBase64 });
    await expect(manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: opened.uploadId, index: 0,
      payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 }))
      .resolves.toEqual({ success: true });
    await expect(manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: opened.uploadId }))
      .resolves.toMatchObject({ success: true, transferId: opened.uploadId, sizeBytes: bytes.length });
    expect(acquireDeploymentRestoreUpload(store, { transferId: opened.uploadId, accountId: 'other', environmentId: 'environment' })).toBeNull();
    const admitted = acquireDeploymentRestoreUpload(store, { transferId: opened.uploadId, accountId: 'account', environmentId: 'environment' });
    if (!admitted) throw new Error('Completed restore source was not retained');
    try { expect(await admitted.source.readChunk({ offset: 0, length: bytes.length })).toEqual(bytes); }
    finally { admitted.release(); }
    await expect(manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, { uploadId: opened.uploadId }))
      .resolves.toEqual({ success: true });

    await writeFile(join(directory, 'download.bin'), bytes);
    const recipient = createTransferRecipientKeyPair();
    const download: unknown = await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
      { t: 'session_file_download_v1', path: 'download.bin', recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 });
    if (!download || typeof download !== 'object' || !('downloadId' in download) || typeof download.downloadId !== 'string') throw new Error('Raw download was not opened');
    const downloaded = z.object({ success: z.literal(true), payloadBase64: z.string(), encryptedDataKeyEnvelopeBase64: z.string() })
      .parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, { downloadId: download.downloadId, index: 0 }));
    expect(decryptEncryptedTransferChunkEnvelope({ transferId: download.downloadId, sequence: 0,
      payloadBase64: downloaded.payloadBase64, encryptedDataKeyEnvelopeBase64: downloaded.encryptedDataKeyEnvelopeBase64,
      recipientSecretKeySeed: recipient.recipientSecretKeySeed })).toEqual(bytes);
    await expect(manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId: download.downloadId }))
      .resolves.toEqual({ success: true });
  } finally {
    await registration.dispose(); await lifecycle.stop(); await store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('serves an approved workspace export through registered prepared RPC phases and settles its original owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-prepared-rpc-seam-'));
  const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
  const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
  const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
    spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable in transfer test' }),
    stopSession: async () => true, requestShutdown() {},
    preparedMachineTransfer: { request: input => lifecycle.requestPreparedTransfer(input) },
  } });
  try {
    const bytes = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(directory, 'binary.bin'), bytes);
    const scope = { rootPath: directory, requesterAccountId: 'account', destinationId: 'browser' };
    const prepared = await prepareWorkspaceFileExport({ lifecycle, filesystemScope: scope,
      request: { workingDirectory: directory, path: 'binary.bin', asZip: false } });
    const endpoint = prepared.endpointCandidates[0];
    if (!endpoint?.authorizationToken) throw new Error('Prepared capability is unavailable');
    const basePath = new URL(endpoint.url).pathname;
    const recipient = createTransferRecipientKeyPair();
    const request = { t: 'prepared_machine_transfer_v1' as const,
      authorizationToken: endpoint.authorizationToken, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
    const call = async (method: string, path: string, httpMethod: 'GET' | 'POST', body?: unknown) =>
      PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(method, { ...request, path, httpMethod, ...(body === undefined ? {} : { body }) }));
    const opened = await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, `${basePath}/open`, 'POST');
    expect(opened.status).toBe(200);
    expect(JSON.parse(opened.body)).toMatchObject({ transferId: prepared.transferId, sizeBytes: bytes.length });
    const refused = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
      { ...request, authorizationToken: 'wrong-capability', path: `${basePath}/chunks/0`, httpMethod: 'GET' }));
    expect(refused.status).toBe(401);
    await expect(manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
      { ...request, path: `${basePath}/chunks/0`, httpMethod: 'GET' })).resolves.toMatchObject({ errorCode: 'invalid_request' });
    const chunkResponse = await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, `${basePath}/chunks/0`, 'GET');
    expect(chunkResponse.status).toBe(200);
    const chunk = TransferChunkEnvelopeSchema.parse(JSON.parse(chunkResponse.body));
    if (chunk.kind !== 'chunk' || !chunk.encryptedDataKeyEnvelopeBase64) throw new Error('Encrypted chunk required');
    expect(decryptEncryptedTransferChunkEnvelope({ transferId: prepared.transferId, sequence: chunk.sequence,
      payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
      recipientSecretKeySeed: recipient.recipientSecretKeySeed })).toEqual(bytes);
    const settled = lifecycle.waitForFilesystemExportSettlement(prepared.transferId, scope);
    expect((await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, `${basePath}/complete`, 'POST',
      { destinationId: scope.destinationId, success: true, sizeBytes: bytes.length, manifestHash: prepared.manifestHash })).status).toBe(200);
    await expect(settled).resolves.toEqual({ success: true, sizeBytes: bytes.length, manifestHash: prepared.manifestHash });
    expect((await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, `${basePath}/chunks/0`, 'GET')).status).toBe(401);
    const cancelled = await prepareWorkspaceFileExport({ lifecycle, filesystemScope: scope,
      request: { workingDirectory: directory, path: 'binary.bin', asZip: false } });
    const cancellationEndpoint = cancelled.endpointCandidates[0];
    if (!cancellationEndpoint?.authorizationToken) throw new Error('Cancellation capability is unavailable');
    const cancellationSettlement = lifecycle.waitForFilesystemExportSettlement(cancelled.transferId, scope);
    const cancellationResponse = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
      { ...request, authorizationToken: cancellationEndpoint.authorizationToken,
        path: `${new URL(cancellationEndpoint.url).pathname}/complete`, httpMethod: 'POST',
        body: { destinationId: scope.destinationId, success: false, error: 'Cancelled by recipient', errorCode: 'cancelled' } }));
    expect(cancellationResponse.status).toBe(200);
    await expect(cancellationSettlement).resolves.toMatchObject({ success: false, errorCode: 'cancelled' });
  } finally {
    await registration.dispose();
    await lifecycle.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('writes and aborts the original prepared import through registered RPC phases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-prepared-import-rpc-seam-'));
  const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
  const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
  const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
    spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable in transfer test' }),
    stopSession: async () => true, requestShutdown() {},
    preparedMachineTransfer: { request: lifecycle.requestPreparedTransfer },
  } });
  try {
    const scope = { rootPath: directory, requesterAccountId: 'account' };
    const bytes = Buffer.from([0, 255, 128, 10]);
    const prepared = await lifecycle.prepareImportSession({ t: 'session_file_upload_v1', workingDirectory: directory,
      path: 'received.bin', sizeBytes: bytes.length, overwrite: false }, scope);
    const chunk = createEncryptedTransferChunkEnvelope({ transferId: prepared.uploadId, sequence: 0,
      payload: bytes, recipientPublicKeyBase64: prepared.recipientPublicKeyBase64 });
    const basePath = new URL(prepared.endpointCandidates[0]!.url).pathname;
    const request = { t: 'prepared_machine_transfer_v1' as const };
    const written = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
      { ...request, path: `${basePath}/chunks/0`, httpMethod: 'PUT', body: chunk }));
    expect(written.status).toBe(200);
    const settlement = lifecycle.waitForImportTransferSettlement(prepared.uploadId, scope);
    const finalized = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
      { ...request, path: `${basePath}/finalize`, httpMethod: 'POST' }));
    expect(finalized.status).toBe(200);
    await expect(settlement).resolves.toMatchObject({ success: true, finalized: { path: 'received.bin' } });
    expect(await readFile(join(directory, 'received.bin'))).toEqual(bytes);
    const cancelled = await lifecycle.prepareImportSession({ t: 'session_file_upload_v1', workingDirectory: directory,
      path: 'cancelled.bin', sizeBytes: bytes.length, overwrite: false }, scope);
    const cancellationSettlement = lifecycle.waitForImportTransferSettlement(cancelled.uploadId, scope);
    const aborted = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
      { ...request, path: `${new URL(cancelled.endpointCandidates[0]!.url).pathname}/abort`, httpMethod: 'POST' }));
    expect(aborted.status).toBe(200);
    await expect(cancellationSettlement).resolves.toMatchObject({ success: false, errorCode: 'cancelled' });
    await expect(readFile(join(directory, 'cancelled.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await registration.dispose(); await lifecycle.stop(); await rm(directory, { recursive: true, force: true });
  }
});
