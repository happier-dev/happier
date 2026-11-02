import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod/mini';
import { FilesystemEntryTreeDescriptorSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';

import type { DirectTransferImportSessionManager } from '@/machines/transfer/directTransferImportSession';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { NativeTransferSessionOwner } from '@happier-dev/transfers/node';
import type { FilesystemEffectConfiguration } from './filesystemEffectOperation';
import type { createWorkspaceEntryExportSource } from '@/machines/transfer/prepareWorkspaceFileExport';
import type { createFilesystemEffectEntryOwner } from './filesystemEffectEntries';

export type FilesystemEffectChannel = Readonly<{
  request: (request: unknown) => Promise<unknown>;
  dispose: () => Promise<void>;
}>;

const failure = (code = 'filesystem_identity_custody_unavailable') => Object.assign(
  new Error('Native filesystem operation is unavailable'), { code });
const envelopeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), code: z.string() }),
]);

/** Serialized requests on the SAME supervised native operation. The caller
 * supplies its real pipes and physical-settlement cleanup; this is not a spawn,
 * admission, retry, timeout or identity owner. */
export function createFilesystemEffectChannel(input: Readonly<{
  output: Readable; input: Writable; signal?: AbortSignal; dispose: () => Promise<void>;
}>): FilesystemEffectChannel {
  const lines = createInterface({ input: input.output, crlfDelay: Infinity });
  let pending: Readonly<{ resolve(value: unknown): void; reject(error: unknown): void }> | undefined;
  let terminal: unknown;
  let tail = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const fail = (error: unknown) => {
    terminal ??= error;
    pending?.reject(terminal);
    pending = undefined;
  };
  lines.on('line', line => {
    if (!pending) { fail(failure()); return; }
    const response = pending;
    pending = undefined;
    try {
      const envelope = envelopeSchema.parse(JSON.parse(line));
      if (envelope.ok) response.resolve(envelope.value);
      else response.reject(failure(envelope.code));
    } catch { response.reject(failure()); fail(failure()); }
  });
  lines.once('close', () => { fail(failure()); });
  const abort = () => { fail(input.signal?.reason ?? failure('cancelled')); };
  input.signal?.addEventListener('abort', abort, { once: true });
  input.output.on('error', fail);
  input.input.on('error', fail);
  return {
    request(request) {
      const result = tail.then(async () => {
        input.signal?.throwIfAborted();
        if (terminal) throw terminal;
        return await new Promise<unknown>((resolve, reject) => {
          pending = { resolve, reject };
          input.input.write(`${JSON.stringify(request)}\n`, error => { if (error) fail(error); });
        });
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    dispose() {
      disposal ??= (async () => {
        fail(failure());
        input.signal?.removeEventListener('abort', abort);
        let pipeFailure: unknown;
        try { lines.close(); input.input.end(); } catch (error) { pipeFailure = error; }
        try { await input.dispose(); if (pipeFailure !== undefined) throw pipeFailure; }
        finally { input.output.removeListener('error', fail); input.input.removeListener('error', fail); }
      })();
      return disposal;
    },
  };
}

export async function initializeFilesystemEffectChannel(channel: FilesystemEffectChannel,
  configuration: FilesystemEffectConfiguration): Promise<void> {
  z.strictObject({ ready: z.literal(true) }).parse(await channel.request({ kind: 'initialize', ...configuration }));
}

const successSchema = z.strictObject({ success: z.literal(true) });
const rejectedSchema = z.object({ success: z.literal(false), error: z.string(), errorCode: z.optional(z.string()) });
const uploadOpenSchema = z.union([rejectedSchema, z.strictObject({ success: z.literal(true), response: z.strictObject({
  uploadId: z.string(), destDisplayPath: z.string(), expectedSizeBytes: z.number(), chunkSizeBytes: z.number(),
  recipientPublicKeyBase64: z.string(), expiresAt: z.number(),
}) })]);
const uploadFinalizeSchema = z.union([z.object({ success: z.literal(false), error: z.string(), errorCode: z.optional(z.string()),
  keepSession: z.optional(z.boolean()), expiresAt: z.optional(z.number()) }),
z.strictObject({ success: z.literal(true), sha256: z.string(), finalized: z.strictObject({
  success: z.literal(true), path: z.string(), sizeBytes: z.number(), result: z.optional(z.unknown()),
}) })]);

export type NativeFilesystemImport = Pick<DirectTransferImportSessionManager,
  'openTrustedImportSession' | 'finalizeImportTransferSession' | 'abortImportTransferSession'> & Readonly<{
    writeImportTransferChunk: (input: Parameters<DirectTransferImportSessionManager['writeImportTransferChunk']>[0]) => Promise<
      Awaited<ReturnType<DirectTransferImportSessionManager['writeImportTransferChunk']>> & Readonly<{ expiresAt?: number }>>;
  }>;

/** Existing mounted import owner keeps its HTTP token, settlement and scope.
 * Its byte and commit callbacks call this exact retained native process. */
export function createFilesystemEffectImportAdapter(channel: FilesystemEffectChannel, stageId?: string): NativeFilesystemImport {
  return {
    async openTrustedImportSession(input) {
      return uploadOpenSchema.parse(await channel.request({ kind: 'upload.open', input, ...(stageId ? { stageId } : {}) }));
    },
    async writeImportTransferChunk(input) {
      const result = z.strictObject({ response: z.union([successSchema, rejectedSchema]), expiresAt: z.nullable(z.number()) })
        .parse(await channel.request({ kind: 'upload.chunk', ...input }));
      return { ...result.response, ...(result.expiresAt === null ? {} : { expiresAt: result.expiresAt }) };
    },
    async finalizeImportTransferSession(input) {
      return uploadFinalizeSchema.parse(await channel.request({ kind: 'upload.finalize', ...input, ...(stageId ? { stageId } : {}) }));
    },
    async abortImportTransferSession(input) {
      const response = await channel.request({ kind: 'upload.abort', ...input });
      if (response !== undefined) return z.strictObject({ aborted: z.boolean() }).parse(response);
      return undefined;
    },
  };
}

export type NativeFilesystemPayloadSource = Extract<TransferPayloadSource, { kind: 'native' }> & Readonly<{ name: string; dispose: () => Promise<void> }>;

const sourceDescriptorSchema = z.strictObject({ sourceId: z.string(), name: z.string(),
  sizeBytes: z.number().check(z.int(), z.nonnegative()), manifestHash: z.string() });
function nativePayloadSource(channel: FilesystemEffectChannel, response: z.infer<typeof sourceDescriptorSchema>): NativeFilesystemPayloadSource {
  let closed = false;
  return {
    kind: 'native', sizeBytes: response.sizeBytes, name: response.name, manifestHash: response.manifestHash,
    async readChunk({ offset, length }) {
      if (closed) throw failure();
      const chunk = z.strictObject({ contentBase64: z.string() })
        .parse(await channel.request({ kind: 'download.read', sourceId: response.sourceId, offset, length }));
      return Buffer.from(chunk.contentBase64, 'base64');
    },
    async dispose() {
      if (closed) return;
      closed = true;
      successSchema.parse(await channel.request({ kind: 'download.close', sourceId: response.sourceId }));
    },
  };
}

export async function openFilesystemEffectDownload(channel: FilesystemEffectChannel,
  request: Readonly<{ path: string; asZip: boolean }>): Promise<NativeFilesystemPayloadSource> {
  const response = z.union([rejectedSchema, z.strictObject({ success: z.literal(true), sourceId: z.string(), name: z.string(),
    sizeBytes: z.number().check(z.int(), z.nonnegative()), manifestHash: z.string() })])
    .parse(await channel.request({ kind: 'download.open', ...request }));
  if (!response.success) throw Object.assign(new Error(response.error), { code: response.errorCode ?? 'filesystem_transfer_failed' });
  return nativePayloadSource(channel, response);
}

export async function openFilesystemEffectEntryExport(channel: FilesystemEffectChannel,
  input: Readonly<{ rootPath: string; path: string; operationId: string }>): ReturnType<typeof createWorkspaceEntryExportSource> {
  const response = z.extend(sourceDescriptorSchema, { entryTree: FilesystemEntryTreeDescriptorSchema })
    .parse(await channel.request({ kind: 'entry.export', input }));
  const allowed = new Set(response.entryTree.blobs.map(blob => blob.transferId));
  return { payloadSource: nativePayloadSource(channel, response), name: response.name,
    sizeBytes: response.sizeBytes, manifestHash: response.manifestHash, entryTree: response.entryTree,
    onDemandScope: {
      allowTransferId: transferId => allowed.has(transferId), maxResolvedTransfers: allowed.size,
      resolvePayloadSourceOnOpen: async ({ transferId }) => {
        if (!allowed.has(transferId)) throw failure('access_denied');
        const payload = sourceDescriptorSchema.parse(await channel.request({ kind: 'entry.resolve', sourceId: response.sourceId, transferId }));
        return nativePayloadSource(channel, payload);
      },
    } };
}

export type NativeFilesystemEntryDestination = Readonly<{
  stageId: string; importSession: NativeFilesystemImport;
  apply: (payloads: readonly Readonly<{ transferId: string; uploadId: string }>[]) => ReturnType<ReturnType<typeof createFilesystemEffectEntryOwner>['apply']>;
  dispose: (retain: boolean) => Promise<void>;
}>;
export async function prepareFilesystemEffectEntryDestination(channel: FilesystemEffectChannel,
  input: Parameters<ReturnType<typeof createFilesystemEffectEntryOwner>['prepare']>[0]): Promise<NativeFilesystemEntryDestination> {
  const { stageId } = z.strictObject({ stageId: z.string() }).parse(await channel.request({ kind: 'entry.prepare', input }));
  return { stageId, importSession: createFilesystemEffectImportAdapter(channel, stageId),
    async apply(payloads) {
      return z.union([z.strictObject({ status: z.enum(['installed', 'restored']) }),
        z.strictObject({ status: z.literal('recovery_needed'), recoveryPath: z.string() })])
        .parse(await channel.request({ kind: 'entry.apply', stageId, payloads }));
    },
    async dispose(retain) { successSchema.parse(await channel.request({ kind: 'entry.close', stageId, retain })); },
  };
}

/** One adapter bound to the parent-selected operation, reused by mounted IO. */
export function createFilesystemEffectTransferAdapter(channel: FilesystemEffectChannel) {
  return {
    importSession: createFilesystemEffectImportAdapter(channel),
    openDownload: (input: Parameters<typeof openFilesystemEffectDownload>[1]) => openFilesystemEffectDownload(channel, input),
    openEntryExport: (input: Parameters<typeof openFilesystemEffectEntryExport>[1]) => openFilesystemEffectEntryExport(channel, input),
    prepareEntryDestination: (input: Parameters<typeof prepareFilesystemEffectEntryDestination>[1]) => prepareFilesystemEffectEntryDestination(channel, input),
  };
}

export function createFilesystemEffectRpcOwner(channel: FilesystemEffectChannel,
  verifyInvocation: NativeTransferSessionOwner['verifyInvocation'],
  promote: NativeTransferSessionOwner['promote']): NativeTransferSessionOwner {
  let expiresAt: number | undefined;
  return { async invoke(method, input) {
      const result = z.strictObject({ response: z.unknown(), expiresAt: z.optional(z.number()) })
        .parse(await channel.request({ kind: 'rpc', method, input }));
      expiresAt = result.expiresAt;
      return result.response;
    },
    verifyInvocation, promote, readExpiry: () => expiresAt, dispose: () => channel.dispose(),
    async describeDownload(downloadId, includeManifest) {
      return z.strictObject({ nextIndex: z.number().check(z.int(), z.nonnegative()), sizeBytes: z.number().check(z.int(), z.nonnegative()),
        recipientPublicKeyBase64: z.optional(z.string()), manifestHash: z.optional(z.string()) })
        .parse(await channel.request({ kind: 'rpc.download.describe', downloadId, includeManifest }));
    },
  };
}
