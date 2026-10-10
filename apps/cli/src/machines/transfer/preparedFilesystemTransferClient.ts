import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/mini';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { uploadInChunks } from '@happier-dev/transfers';
import {
  FilesystemUploadOutputSchema, FilesystemDownloadOutputSchema, FilesystemCopyOutputSchema,
  type FilesystemUploadOutput, type FilesystemDownloadOutput, type FilesystemTransferActionId,
  type FilesystemUploadInput, type FilesystemPreparedCopyInput, type FilesystemTargetCopyInput, type FilesystemCopyOutput,
} from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { FiniteTransferMachineTunnel } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { requestDirectPeerTransferToFile } from './directPeerTransport';
import { encodeDirectPeerTransferPathKey } from './directPeerTransport/protocol';
import { createFileTransferPayloadSource, resolveTransferPayloadManifestHash } from './transferPayloadSource';
import { readJsonResponseWithBodyLimit } from './directPeerTransport/requestTransfer';
import { resolveDirectPeerTransferOpenBodyMaxBytes } from './transferRuntimeConfig';

const FinalizeSchema = z.union([
  z.strictObject({ success: z.literal(true), finalized: z.strictObject({ success: z.literal(true), path: z.string(), sizeBytes: z.number(), result: z.optional(z.unknown()) }), sha256: z.string() }),
  z.strictObject({ success: z.literal(false), error: z.string(), errorCode: z.optional(z.string()), keepSession: z.optional(z.boolean()), expiresAt: z.optional(z.number()) }),
]);
const ChunkSchema = z.union([z.strictObject({ success: z.literal(true) }),
  z.strictObject({ success: z.literal(false), error: z.string() })]);

/** Headless finite-file adapter. Admission and lifecycle remain the remote Action owner. */
export function createPreparedFilesystemTransferClient(params: Readonly<{
  openMachineTunnel: (input: Readonly<{ targetMachineId: string; serverId?: string; signal?: AbortSignal }>) => Promise<FiniteTransferMachineTunnel>;
  executeAction: (actionId: FilesystemTransferActionId | 'daemon.filesystem.copy' | 'action.operations.get', input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>) {
  const invoke = async (actionId: FilesystemTransferActionId | 'daemon.filesystem.copy' | 'action.operations.get', input: unknown, targetMachineId: string, serverId?: string, signal?: AbortSignal) => {
    const result = await params.executeAction(actionId, input, { externalActionTarget: { kind: 'machine', machineId: targetMachineId },
      ...(serverId ? { serverId } : {}), ...(signal ? { signal } : {}) });
    if (!result.ok) throw Object.assign(new Error(result.error), { errorCode: result.errorCode });
    return result.result;
  };
  const client = {
    async upload(input: Readonly<{ targetMachineId: string; serverId?: string; rootPath: string; path: string;
      sourcePath: string; source?: FilesystemUploadInput['source']; overwrite: boolean; signal?: AbortSignal;
      preparedCopy?: FilesystemPreparedCopyInput;
      preparedAdmission?: Extract<FilesystemUploadOutput, { success: true; status: 'accepted' }> }>): Promise<FilesystemUploadOutput | ActionApprovalRequestCreatedResult> {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let tunnel: Awaited<ReturnType<typeof params.openMachineTunnel>> | undefined;
      let preparedUploadId: string | undefined;
      let preparedAbortEndpoint: string | undefined;
      let abortConfirmed = false;
      let acceptedImport = input.preparedAdmission !== undefined;
      const failure = (error: string, errorCode?: string): FilesystemUploadOutput =>
        acceptedImport && !abortConfirmed
          ? { success: false, status: 'unknown', error, errorCode: 'indeterminate' }
          : { success: false, status: input.signal?.aborted ? 'cancelled' : 'failed', error, ...(errorCode ? { errorCode } : {}) };
      try {
        file = await open(input.sourcePath, 'r');
        const stat = await file.stat();
        const sourceId = input.source?.sourceId ?? randomUUID();
        const manifestHash = await resolveTransferPayloadManifestHash(createFileTransferPayloadSource({ filePath: input.sourcePath, sizeBytes: stat.size }));
        const sha256 = manifestHash.slice('sha256:'.length);
        if (input.source && (input.source.sizeBytes !== stat.size || (input.source.sha256 && input.source.sha256.toLowerCase() !== sha256))) {
          return failure('Prepared source does not match the local file', 'source_identity_mismatch');
        }
        const admission = input.preparedAdmission ?? await invoke(input.preparedCopy ? 'daemon.filesystem.copy' : 'daemon.filesystem.upload', input.preparedCopy ?? {
          rootPath: input.rootPath, path: input.path, overwrite: input.overwrite, source: { sourceId, sizeBytes: stat.size, sha256 },
        }, input.targetMachineId, input.serverId, input.signal);
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(admission);
        if (approval.success) return approval.data;
        const receipt = FilesystemUploadOutputSchema.parse(admission);
        if (!receipt.success || receipt.status !== 'accepted') return receipt;
        acceptedImport = true;
        preparedUploadId = receipt.prepared.uploadId;
        if (receipt.sourceId !== sourceId || receipt.prepared.expectedSizeBytes !== stat.size) throw new Error('Prepared upload source identity does not match');
        tunnel = await params.openMachineTunnel({ targetMachineId: input.targetMachineId, ...(input.serverId ? { serverId: input.serverId } : {}), ...(input.signal ? { signal: input.signal } : {}) });
        const candidate = receipt.prepared.endpointCandidates[0];
        if (!candidate) throw new Error('Prepared upload endpoints are unavailable');
        const url = carrierUrl(candidate.url, tunnel.localPort);
        preparedAbortEndpoint = appendEndpoint(url, 'abort');
        const result = await uploadPreparedFile({ file, prepared: receipt.prepared, endpoint: url, signal: input.signal,
          abort: async () => {
            const result = await postJson(appendEndpoint(url, 'abort'));
            abortConfirmed = ChunkSchema.parse(result).success;
            return result;
          },
        });
        if (!result.success) return result.errorCode === 'indeterminate'
          ? { success: false, status: 'unknown', error: result.error ?? 'Upload failed', errorCode: 'indeterminate' }
          : failure(result.error ?? 'Upload failed', result.errorCode);
        if (!('finalized' in result)) throw new Error('Prepared upload finalize result is unavailable');
        return { success: true, status: 'completed', transferId: receipt.prepared.uploadId, sourceId,
          path: result.finalized.path, sizeBytes: result.finalized.sizeBytes, sha256: result.sha256 };
      } catch (error) {
        if (preparedUploadId && preparedAbortEndpoint) {
          try { abortConfirmed = ChunkSchema.parse(await postJson(preparedAbortEndpoint)).success; } catch { /* The admitted owner retains unconfirmed custody. */ }
        }
        return failure(error instanceof Error ? error.message : 'Upload failed',
          error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? error.errorCode : undefined);
      } finally { try { await file?.close(); } finally { await tunnel?.close(); } }
    },
    async download(input: Readonly<{ targetMachineId: string; serverId?: string; rootPath: string; path: string;
      destinationPath: string; destinationId?: string; asZip: boolean; signal?: AbortSignal }>): Promise<FilesystemDownloadOutput | ActionApprovalRequestCreatedResult> {
      let tunnel: Awaited<ReturnType<typeof params.openMachineTunnel>> | undefined;
      let receipt: Extract<FilesystemDownloadOutput, { success: true; status: 'accepted' }> | undefined;
      let destinationClosed = false;
      try {
        const destinationId = input.destinationId ?? randomUUID();
        const admission = await invoke('daemon.filesystem.download', {
          rootPath: input.rootPath, path: input.path, asZip: input.asZip, destination: { destinationId },
        }, input.targetMachineId, input.serverId, input.signal);
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(admission);
        if (approval.success) return approval.data;
        const accepted = FilesystemDownloadOutputSchema.parse(admission);
        if (!accepted.success || accepted.status !== 'accepted') return accepted;
        receipt = accepted;
        if (receipt.destinationId !== destinationId) throw new Error('Prepared download destination identity does not match');
        tunnel = await params.openMachineTunnel({ targetMachineId: input.targetMachineId, ...(input.serverId ? { serverId: input.serverId } : {}), ...(input.signal ? { signal: input.signal } : {}) });
        const localPort = tunnel.localPort;
        const candidates = receipt.prepared.endpointCandidates.map(candidate => ({ ...candidate, kind: 'http' as const,
          url: carrierUrl(candidate.url, localPort) }));
        const result = await requestDirectPeerTransferToFile({ transferId: receipt.prepared.transferId, endpointCandidates: candidates,
          destinationPath: input.destinationPath, expectedSizeBytes: receipt.prepared.sizeBytes,
          expectedManifestHash: receipt.prepared.manifestHash, ...(input.signal ? { signal: input.signal } : {}) });
        destinationClosed = true;
        const candidate = candidates[0];
        if (!candidate) throw new Error('Prepared download endpoints are unavailable');
        const ack = await postJson(appendEndpoint(candidate.url, 'complete'), { success: true, destinationId,
          sizeBytes: result.sizeBytes, manifestHash: result.manifestHash }, undefined, 'POST', candidate.authorizationToken);
        if (!ChunkSchema.parse(ack).success) return { success: false, status: 'unknown', error: 'Download completion was not acknowledged', errorCode: 'indeterminate' };
        return { success: true, status: 'completed', transferId: receipt.prepared.transferId, destinationId,
          name: receipt.prepared.name, sizeBytes: result.sizeBytes, sha256: result.manifestHash.slice('sha256:'.length) };
      } catch (error) {
        if (receipt && !destinationClosed && tunnel) {
          const candidate = receipt.prepared.endpointCandidates[0];
          if (candidate) await postJson(appendEndpoint(carrierUrl(candidate.url, tunnel.localPort), 'complete'), {
            success: false, destinationId: receipt.destinationId, error: error instanceof Error ? error.message : 'Download failed',
            ...(input.signal?.aborted ? { errorCode: 'cancelled' } : {}),
          }, undefined, 'POST', candidate.authorizationToken).catch(() => undefined);
        }
        return { success: false, status: destinationClosed ? 'unknown' : input.signal?.aborted ? 'cancelled' : 'failed',
          error: error instanceof Error ? error.message : 'Download failed', ...(destinationClosed ? { errorCode: 'indeterminate' } : {}) };
      } finally { await tunnel?.close(); }
    },
    async copy(input: (Omit<FilesystemPreparedCopyInput, 'kind'> | Omit<FilesystemTargetCopyInput, 'kind'>) & Readonly<{ signal?: AbortSignal;
      preparedAdmission?: Extract<FilesystemUploadOutput, { success: true; status: 'accepted' }> }>): Promise<FilesystemCopyOutput | ActionApprovalRequestCreatedResult> {
      if ('kind' in input.source && input.source.kind === 'entry_tree') return { success: false, status: 'failed',
        error: 'The original prepared entry export capability is required.', errorCode: 'filesystem_transfer_custody_required' };
      if (!('kind' in input.source)) return await copyEntry(input);
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-filesystem-copy-'));
      const sourcePath = join(temporaryDirectory, 'source');
      try {
        const downloaded = await client.download({ targetMachineId: input.source.machineId, serverId: input.source.serverId,
          rootPath: input.source.rootPath, path: input.source.path, destinationPath: sourcePath, asZip: false,
          ...(input.signal ? { signal: input.signal } : {}) });
        if ('kind' in downloaded || !downloaded.success) return input.preparedAdmission
          ? { success: false, status: 'unknown', error: 'The admitted copy could not consume its source', errorCode: 'indeterminate' } : downloaded;
        if (downloaded.status !== 'completed' || ('sourceId' in input.source && (downloaded.sizeBytes !== input.source.sizeBytes
          || downloaded.sha256.toLowerCase() !== input.source.sha256.toLowerCase()))) {
          return { success: false, status: input.preparedAdmission ? 'unknown' : 'failed', error: 'Prepared copy source identity does not match the admitted bytes',
            errorCode: input.preparedAdmission ? 'indeterminate' : 'source_identity_mismatch' };
        }
        const source = 'sourceId' in input.source ? input.source : { ...input.source, kind: 'file' as const,
          sourceId: downloaded.transferId, sizeBytes: downloaded.sizeBytes, sha256: downloaded.sha256 };
        return await client.upload({ targetMachineId: input.destination.machineId, serverId: input.destination.serverId,
          rootPath: input.destination.rootPath, path: input.destination.path, sourcePath,
          source, overwrite: input.overwrite,
          preparedCopy: { kind: 'prepared_transfer', source, destination: input.destination,
            overwrite: input.overwrite, recursive: input.recursive },
          ...(input.preparedAdmission ? { preparedAdmission: input.preparedAdmission } : {}), ...(input.signal ? { signal: input.signal } : {}) });
      } catch (error) {
        return { success: false, status: input.preparedAdmission ? 'unknown' : input.signal?.aborted ? 'cancelled' : 'failed',
          error: error instanceof Error ? error.message : 'Copy source is unavailable',
          ...(input.preparedAdmission ? { errorCode: 'indeterminate' } : {}) };
      } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
    },
  };
  const copyEntry = async (input: (Omit<FilesystemPreparedCopyInput, 'kind'> | Omit<FilesystemTargetCopyInput, 'kind'>) & Readonly<{ signal?: AbortSignal }>): Promise<FilesystemCopyOutput | ActionApprovalRequestCreatedResult> => {
    const custody = await mkdtemp(join(tmpdir(), 'happier-filesystem-entry-copy-'));
    let sourceTunnel: FiniteTransferMachineTunnel | undefined;
    let destinationTunnel: FiniteTransferMachineTunnel | undefined;
    let sourceReceipt: Extract<FilesystemDownloadOutput, { success: true; status: 'accepted' }> | undefined;
    let copyReceipt: Extract<FilesystemCopyOutput, { success: true; status: 'accepted' }> | undefined;
    let retainImports = false;
    let sourceClosed = false;
    try {
      const destinationId = randomUUID();
      const admission = await invoke('daemon.filesystem.download', { rootPath: input.source.rootPath, path: input.source.path,
        asZip: false, format: 'entry_tree', destination: { destinationId } }, input.source.machineId, input.source.serverId, input.signal);
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(admission);
      if (approval.success) return approval.data;
      const receipt = FilesystemDownloadOutputSchema.parse(admission);
      if (!receipt.success || receipt.status !== 'accepted') return receipt;
      sourceReceipt = receipt;
      if (!('entryTree' in receipt) || receipt.destinationId !== destinationId) throw new Error('Entry source custody is unavailable');
      if (receipt.entryTree.expectation.kind === 'missing') throw new Error('Copy source is missing');
      if (receipt.entryTree.expectation.kind === 'directory' && !input.recursive) throw new Error('A directory copy requires recursive=true');
      if ('kind' in input.source && input.source.kind === 'entry_tree' && (input.source.sizeBytes !== receipt.prepared.sizeBytes
        || `sha256:${input.source.sha256.toLowerCase()}` !== receipt.prepared.manifestHash.toLowerCase()
        || JSON.stringify(input.source.entryTree) !== JSON.stringify(receipt.entryTree))) throw new Error('Prepared entry source identity changed');
      sourceTunnel = await params.openMachineTunnel({ serverId: input.source.serverId, targetMachineId: input.source.machineId, signal: input.signal });
      const sourcePort = sourceTunnel.localPort;
      const payloads = [{ transferId: receipt.entryTree.operationId, sizeBytes: receipt.prepared.sizeBytes, manifestHash: receipt.prepared.manifestHash }, ...receipt.entryTree.blobs];
      const sourceFiles = new Map<string, string>();
      for (const payload of payloads) {
        const destinationPath = join(custody, `payload-${sourceFiles.size}`);
        const candidates = receipt.prepared.endpointCandidates.map(candidate => ({ ...candidate, kind: 'http' as const,
          url: payloadEndpoint(carrierUrl(candidate.url, sourcePort), payload.transferId) }));
        await requestDirectPeerTransferToFile({ transferId: payload.transferId, endpointCandidates: candidates, destinationPath,
          expectedSizeBytes: payload.sizeBytes, expectedManifestHash: payload.manifestHash, signal: input.signal });
        sourceFiles.set(payload.transferId, destinationPath);
      }
      sourceClosed = true;
      const sourceCandidate = receipt.prepared.endpointCandidates[0];
      if (!sourceCandidate) throw new Error('Entry export endpoints are unavailable');
      const acknowledged = ChunkSchema.parse(await postJson(appendEndpoint(carrierUrl(sourceCandidate.url, sourcePort), 'complete'),
        { success: true, destinationId, sizeBytes: receipt.prepared.sizeBytes, manifestHash: receipt.prepared.manifestHash }, undefined, 'POST', sourceCandidate.authorizationToken));
      if (!acknowledged.success) return { success: false, status: 'unknown', error: 'Source completion is unconfirmed', errorCode: 'indeterminate' };
      const source = { ...input.source, kind: 'entry_tree' as const, sourceId: 'sourceId' in input.source ? input.source.sourceId : receipt.prepared.transferId,
        sizeBytes: receipt.prepared.sizeBytes, sha256: receipt.prepared.manifestHash.slice('sha256:'.length), entryTree: receipt.entryTree };
      const admittedCopy = await invoke('daemon.filesystem.copy', { kind: 'prepared_transfer', source, destination: input.destination,
        overwrite: input.overwrite, recursive: input.recursive }, input.destination.machineId, input.destination.serverId, input.signal);
      const copyApproval = ActionApprovalRequestCreatedResultSchema.safeParse(admittedCopy);
      if (copyApproval.success) return copyApproval.data;
      const accepted = FilesystemCopyOutputSchema.parse(admittedCopy);
      if (!accepted.success || !('status' in accepted) || accepted.status !== 'accepted') return accepted;
      copyReceipt = accepted;
      if (!('manifest' in accepted.prepared) || accepted.sourceId !== source.sourceId) throw new Error('Entry destination custody is unavailable');
      const imports = [{ transferId: receipt.entryTree.operationId, prepared: accepted.prepared.manifest }, ...accepted.prepared.blobs];
      if (imports.length !== payloads.length || new Set(imports.map(record => record.transferId)).size !== payloads.length) throw new Error('Entry import commitment changed');
      destinationTunnel = await params.openMachineTunnel({ serverId: input.destination.serverId, targetMachineId: input.destination.machineId, signal: input.signal });
      const destinationPort = destinationTunnel.localPort;
      for (const record of imports) {
        const sourcePath = sourceFiles.get(record.transferId);
        const descriptor = payloads.find(payload => payload.transferId === record.transferId);
        if (!sourcePath || !descriptor || record.prepared.expectedSizeBytes !== descriptor.sizeBytes) throw new Error('Entry payload identity changed');
        const candidate = record.prepared.endpointCandidates[0];
        if (!candidate) throw new Error('Entry import endpoints are unavailable');
        const file = await open(sourcePath, 'r');
        try {
          const uploaded = await uploadPreparedFile({ file, prepared: record.prepared, endpoint: carrierUrl(candidate.url, destinationPort), signal: input.signal,
            abort: async () => await postJson(appendEndpoint(carrierUrl(candidate.url, destinationPort), 'abort')) });
          if (!uploaded.success) { retainImports = uploaded.errorCode === 'indeterminate'; return { success: false, status: retainImports ? 'unknown' : input.signal?.aborted ? 'cancelled' : 'failed',
            error: uploaded.error ?? 'Entry payload upload failed', ...(uploaded.errorCode ? { errorCode: uploaded.errorCode } : {}) }; }
        } finally { await file.close(); }
      }
      retainImports = true;
      const observed = ActionOperationGetV1ResponseSchema.parse(await invoke('action.operations.get', { serverId: input.destination.serverId,
        machineId: input.destination.machineId, operationId: accepted.operationId, waitForTerminal: true }, input.destination.machineId, input.destination.serverId, input.signal));
      if (observed.kind === 'not_found' || observed.operation.state === 'running' || observed.operation.state === 'accepted') return { success: false, status: 'unknown', error: 'Copy native outcome is unconfirmed', errorCode: 'indeterminate' };
      if (observed.operation.state === 'succeeded') return FilesystemCopyOutputSchema.parse(observed.operation.result);
      return { success: false, status: observed.operation.state === 'cancelled' ? 'cancelled' : 'failed', error: observed.operation.error?.error ?? 'Copy failed', errorCode: observed.operation.error?.errorCode ?? 'cancelled' };
    } catch (error) {
      return { success: false, status: retainImports ? 'unknown' : input.signal?.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Entry copy failed', ...(retainImports ? { errorCode: 'indeterminate' } : {}) };
    } finally {
      try {
        if (sourceReceipt && !sourceClosed && sourceTunnel) {
          const candidate = sourceReceipt.prepared.endpointCandidates[0];
          if (candidate) await postJson(appendEndpoint(carrierUrl(candidate.url, sourceTunnel.localPort), 'complete'), {
            success: false, destinationId: sourceReceipt.destinationId, error: 'The containing copy did not complete',
            ...(input.signal?.aborted ? { errorCode: 'cancelled' } : {}),
          }, undefined, 'POST', candidate.authorizationToken).catch(() => undefined);
        }
        if (copyReceipt && !retainImports) {
          const records = 'manifest' in copyReceipt.prepared ? [copyReceipt.prepared.manifest, ...copyReceipt.prepared.blobs.map(record => record.prepared)] : [copyReceipt.prepared];
          if (destinationTunnel) {
            const port = destinationTunnel.localPort;
            await Promise.all(records.map(record => { const candidate = record.endpointCandidates[0];
              return candidate ? postJson(appendEndpoint(carrierUrl(candidate.url, port), 'abort')).catch(() => undefined) : Promise.resolve(); }));
          }
        }
      } finally { try { await sourceTunnel?.close(); } finally { try { await destinationTunnel?.close(); } finally { await rm(custody, { recursive: true, force: true }); } } }
    }
  };
  return client;
}

async function uploadPreparedFile(input: Readonly<{ file: Awaited<ReturnType<typeof open>>;
  prepared: Extract<FilesystemUploadOutput, { success: true; status: 'accepted' }>['prepared']; endpoint: string; signal?: AbortSignal;
  abort: (input: Readonly<{ uploadId: string }>) => Promise<unknown> }>) {
  return await uploadInChunks({ totalBytes: input.prepared.expectedSizeBytes, signal: input.signal,
    init: async () => ({ success: true, ...input.prepared }),
    readBytes: async (offset, length) => { const bytes = Buffer.alloc(length); const { bytesRead } = await input.file.read(bytes, 0, length, offset); return bytes.subarray(0, bytesRead); },
    prepareChunk: async ({ uploadId, index, bytes }) => ({ index, ...createEncryptedTransferChunkEnvelope({ transferId: uploadId, sequence: index, payload: bytes, recipientPublicKeyBase64: input.prepared.recipientPublicKeyBase64 }) }),
    sendChunk: async (chunk, signal) => ChunkSchema.parse(await postJson(appendEndpoint(input.endpoint, `chunks/${chunk.index}`), { payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64 }, signal ?? undefined, 'PUT')),
    finalize: async (_, signal) => {
      try { return FinalizeSchema.parse(await postJson(appendEndpoint(input.endpoint, 'finalize'), undefined, signal ?? undefined)); }
      catch { return { success: false as const, error: 'Upload finalize outcome could not be confirmed', errorCode: 'indeterminate', keepSession: true }; }
    }, retainUploadAfterFinalize: response => !response.success && response.keepSession === true, abort: input.abort });
}

function payloadEndpoint(endpoint: string, transferId: string): string {
  const url = new URL(endpoint); const index = url.pathname.lastIndexOf('/'); url.pathname = `${url.pathname.slice(0, index + 1)}${encodeDirectPeerTransferPathKey(transferId)}`; return url.toString();
}

function carrierUrl(endpoint: string, port: number): string {
  const url = new URL(endpoint);
  url.protocol = 'http:'; url.hostname = '127.0.0.1'; url.port = String(port);
  return url.toString();
}
function appendEndpoint(endpoint: string, suffix: string): string {
  const url = new URL(endpoint); url.pathname = `${url.pathname}/${suffix}`; return url.toString();
}
async function postJson(url: string, body?: unknown, signal?: AbortSignal, method = 'POST', token?: string): Promise<unknown> {
  const response = await fetch(url, { method, redirect: 'error', headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`Prepared transfer HTTP request failed (${response.status})`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('Prepared transfer response is not JSON');
  return await readJsonResponseWithBodyLimit({ response, maxBodyBytes: resolveDirectPeerTransferOpenBodyMaxBytes(),
    onInvalidJson: () => new Error('Prepared transfer response is invalid JSON'),
    onOverLimit: () => new Error('Prepared transfer response exceeds the canonical metadata budget') });
}
