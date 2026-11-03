import { createHash, randomUUID } from 'node:crypto';
import { copyFile, rename, rm } from 'node:fs/promises';
import { z } from 'zod/mini';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { configuration as cliConfiguration } from '@/configuration';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { CapabilitiesDetectRequest, CapabilitiesDetectResponse,
  CapabilitiesInvokeRequest, CapabilitiesInvokeResponse } from '@/capabilities/types';
import { registerTransferDownloadRpcHandlers } from '@/transfers/rpc/registerTransferDownloadRpcHandlers';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';

import { createDirectTransferImportSessionManager } from '@/machines/transfer/directTransferImportSession';
import { DirectTransferImportOpenRequestSchema } from '@/machines/transfer/directTransferImportOpenRequest';
import { createFileTransferPayloadSource, disposeTransferPayloadSource, readTransferPayloadChunk,
  resolveTransferPayloadManifestHash, resolveTransferPayloadSizeBytes, type TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import type { WorkspaceFinalizeFileOperationsFactory } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';
import { executeConfiguredFilesystemEffect, invalidOperation,
  type FilesystemEffectConfiguration } from './filesystemEffectOperation';
import { createFilesystemEffectEntryOwner } from './filesystemEffectEntries';
import { hasFilesystemEffectTransferCustody } from './filesystemEffectTransferCustody';
import { registerReadFileHandler } from './readFileHandler';
import { registerWriteFileHandler } from './writeFileHandler';
import { registerDirectoryHandlers } from './directoryHandlers';
import { registerPathMutationHandlers } from './pathMutationHandlers';
import { registerMachineFileBrowserHandlers } from '../machineFileBrowser/registerMachineFileBrowserHandlers';
import { registerWorkspaceFileSearchHandler } from '../workspaceFileSearch';
import { registerWorkspaceFileListHandler } from '../workspaceFileList';
import { registerSessionCreationDirectoryPreflightRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';

const integer = z.number().check(z.int(), z.nonnegative());
const id = z.string().check(z.minLength(1));
const transferMethods = [RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
  RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
  RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT] as const;
const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('action'), actionId: z.string(), input: z.unknown() }),
  z.strictObject({ kind: z.literal('rpc'), method: z.enum(transferMethods), input: z.unknown() }),
  z.strictObject({ kind: z.literal('filesystem.rpc'), method: z.string(), input: z.unknown() }),
  z.strictObject({ kind: z.literal('rpc.download.describe'), downloadId: id, includeManifest: z.boolean() }),
  z.strictObject({ kind: z.literal('download.open'), path: z.string(), asZip: z.boolean() }),
  z.strictObject({ kind: z.literal('download.read'), sourceId: id, offset: integer, length: integer }),
  z.strictObject({ kind: z.literal('download.close'), sourceId: id }),
  z.strictObject({ kind: z.literal('upload.open'), input: DirectTransferImportOpenRequestSchema, stageId: z.optional(id) }),
  z.strictObject({ kind: z.literal('upload.chunk'), uploadId: id, index: integer,
    contentBase64: z.optional(z.string()), payloadBase64: z.optional(z.string()), encryptedDataKeyEnvelopeBase64: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('upload.finalize'), uploadId: id, stageId: z.optional(id) }),
  z.strictObject({ kind: z.literal('upload.abort'), uploadId: id }),
  z.strictObject({ kind: z.literal('entry.export'), input: z.unknown() }),
  z.strictObject({ kind: z.literal('entry.resolve'), sourceId: id, transferId: id }),
  z.strictObject({ kind: z.literal('entry.prepare'), input: z.unknown() }),
  z.strictObject({ kind: z.literal('entry.apply'), stageId: id, payloads: z.unknown() }),
  z.strictObject({ kind: z.literal('entry.close'), stageId: id, retain: z.boolean() }),
]);

/** A retained byte owner inside the already admitted native process. Only its
 * parent holds this pipe; no listener, Account credentials, or UID policy lives
 * here. The existing import lifecycle owns hashes, encryption, commit and TTL. */
export function createFilesystemEffectByteOwner(configuration: FilesystemEffectConfiguration, signal?: AbortSignal) {
  const sources = new Map<string, TransferPayloadSource>();
  let closed = false;
  const assertOpen = () => { signal?.throwIfAborted(); if (closed) throw invalidOperation(); };
  const finalizeFileOperations: WorkspaceFinalizeFileOperationsFactory = () => ({ prepareCommit: async () => { assertOpen(); },
    rename, rm,
    copyFile: async (source, destination, mode) => { assertOpen(); await copyFile(source, destination, mode); } });
  const uploads = createDirectTransferImportSessionManager({ accessPolicy: configuration.accessPolicy, finalizeFileOperations });
  const registerSource = async (payload: TransferPayloadSource, name: string) => {
    try {
      const [manifestHash, sizeBytes] = await Promise.all([
        resolveTransferPayloadManifestHash(payload), resolveTransferPayloadSizeBytes(payload),
      ]);
      assertOpen();
      const sourceId = randomUUID();
      sources.set(sourceId, { ...payload, manifestHash, sizeBytes });
      return { sourceId, name, sizeBytes, manifestHash };
    } catch (error) { await disposeTransferPayloadSource(payload); throw error; }
  };
  const entries = createFilesystemEffectEntryOwner(configuration, uploads, registerSource, signal);
  const rpcStore = new TransferSessionStore({ ttlMs: cliConfiguration.filesTransferSessionTtlMs });
  const rpcHandlers = new Map<string, RpcHandler<unknown, unknown>>();
  const sessionRpcTransferMaxBytes = configuration.sessionRpcTransferMaxBytes === undefined
    ? resolveServerRoutedTransferMaxBytes() : configuration.sessionRpcTransferMaxBytes;
  const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) {
    rpcHandlers.set(method, handler as RpcHandler<unknown, unknown>);
  } };
  registerSessionCreationDirectoryPreflightRpc({ rpcHandlerManager: registrar });
  // Capability effects were admitted by the parent. Reuse the real service in
  // this member process without returning through its RPC admission handlers.
  const getCapabilities = () => import('../capabilities').then(({ createCliCapabilitiesService }) =>
    createCliCapabilitiesService({ accountContext: { credentials: null, accountSettings: null },
      ...(configuration.capabilitySessionFactories ? { sessionFactorySource: {
        observations: configuration.capabilitySessionFactories,
        isCurrent: () => !closed && signal?.aborted !== true,
      } } : {}) }));
  registrar.registerHandler<CapabilitiesDetectRequest, CapabilitiesDetectResponse>(RPC_METHODS.CAPABILITIES_DETECT,
    async data => (await getCapabilities()).detect(data, { accountId: configuration.requesterAccountId }));
  registrar.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>(RPC_METHODS.CAPABILITIES_INVOKE,
    async data => (await getCapabilities()).invoke(data, signal ? { signal } : {}));
  const filesystemDeps = { workingDirectory: configuration.workingDirectory, accessPolicy: configuration.accessPolicy,
    // The parent already admitted the effect. Registered RPC decoding and
    // mutation routing still use their incumbent executor contract here.
    actionExecutor: { execute: async (actionId: string, input: unknown) => ({ ok: true as const,
      result: await executeConfiguredFilesystemEffect(configuration, { actionId, input }, signal) }) },
    getAdditionalAllowedReadDirs: () => configuration.additionalAllowedReadDirs ?? [],
    getAdditionalAllowedReadFiles: () => configuration.additionalAllowedReadFiles ?? [],
    getAdditionalAllowedWriteDirs: () => configuration.additionalAllowedWriteDirs ?? [],
    limits: { listMaxEntries: cliConfiguration.filesDirectoryListMaxEntries,
      treeMaxDepth: cliConfiguration.filesDirectoryTreeMaxDepth, treeMaxNodes: cliConfiguration.filesDirectoryTreeMaxNodes },
    ...(configuration.machineId ? { mutationMachineId: configuration.machineId } : {}) };
  registerReadFileHandler(registrar, filesystemDeps);
  registerWriteFileHandler(registrar, filesystemDeps);
  registerDirectoryHandlers(registrar, filesystemDeps);
  registerPathMutationHandlers(registrar, filesystemDeps);
  registerMachineFileBrowserHandlers({ rpcHandlerManager: registrar, workingDirectory: configuration.workingDirectory,
    accessPolicy: configuration.accessPolicy });
  registerWorkspaceFileSearchHandler(registrar, configuration.workingDirectory, { accessPolicy: configuration.accessPolicy });
  registerWorkspaceFileListHandler(registrar, configuration.workingDirectory, { accessPolicy: configuration.accessPolicy });
  registerTransferUploadRpcHandlers(registrar, { workingDirectory: configuration.workingDirectory,
    accessPolicy: configuration.accessPolicy, store: rpcStore, sessionRpcTransferMaxBytes, finalizeFileOperations,
    getAdditionalAllowedWriteDirs: () => configuration.additionalAllowedWriteDirs ?? [] });
  registerTransferDownloadRpcHandlers(registrar, { workingDirectory: configuration.workingDirectory,
    accessPolicy: configuration.accessPolicy, store: rpcStore, sessionRpcTransferMaxBytes,
    getAdditionalAllowedReadDirs: () => configuration.additionalAllowedReadDirs ?? [],
    getAdditionalAllowedReadFiles: () => configuration.additionalAllowedReadFiles ?? [] });
  return {
    async execute(raw: unknown): Promise<unknown> {
      assertOpen();
      const command = commandSchema.parse(raw);
      switch (command.kind) {
        case 'filesystem.rpc': {
          if (transferMethods.some(method => method === command.method)) throw invalidOperation();
          const handler = rpcHandlers.get(command.method);
          if (!handler) throw Object.assign(invalidOperation(), { code: 'filesystem_identity_custody_unavailable' });
          return await handler(command.input, { signal: signal ?? new AbortController().signal,
            ...(configuration.callerAuthority ? { callerAuthority: configuration.callerAuthority } : {}) });
        }
        case 'rpc.download.describe': {
          const session = rpcStore.getDownloadSession(command.downloadId);
          if (!session) throw invalidOperation();
          let manifestHash: string | undefined;
          if (command.includeManifest) {
            const hash = createHash('sha256');
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let offset = 0;
            while (offset < session.sizeBytes) {
              assertOpen();
              const { bytesRead } = await session.file.read(buffer, 0, Math.min(buffer.length, session.sizeBytes - offset), session.sourceOffsetBytes + offset);
              if (bytesRead === 0) throw invalidOperation();
              hash.update(buffer.subarray(0, bytesRead));
              offset += bytesRead;
            }
            manifestHash = `sha256:${hash.digest('hex')}`;
          }
          return { nextIndex: session.nextIndex, sizeBytes: session.sizeBytes,
            ...(session.recipientPublicKeyBase64 ? { recipientPublicKeyBase64: session.recipientPublicKeyBase64 } : {}),
            ...(manifestHash ? { manifestHash } : {}) };
        }
        case 'rpc': {
          if (!hasFilesystemEffectTransferCustody(command.method, command.input)) return { response: { success: false,
              errorCode: 'filesystem_identity_custody_unavailable', error: 'This transfer custody is unavailable in the native operation' } };
          const handler = rpcHandlers.get(command.method);
          if (!handler) throw invalidOperation();
          const response = await handler(command.input, { signal: signal ?? new AbortController().signal });
          const result = response && typeof response === 'object' ? response : null;
          const input = command.input && typeof command.input === 'object' ? command.input : null;
          const uploadId: unknown = result && Reflect.get(result, 'uploadId') || input && Reflect.get(input, 'uploadId');
          const downloadId: unknown = result && Reflect.get(result, 'downloadId') || input && Reflect.get(input, 'downloadId');
          const expiresAt = typeof uploadId === 'string' ? rpcStore.getUploadSession(uploadId)?.expiresAt
            : typeof downloadId === 'string' ? rpcStore.getDownloadSession(downloadId)?.expiresAt : undefined;
          return { response, ...(expiresAt === undefined ? {} : { expiresAt }) };
        }
        case 'action': return await executeConfiguredFilesystemEffect(configuration,
          { actionId: command.actionId, input: command.input }, signal);
        case 'download.open': {
          const resolved = await resolveWorkspaceFileDownloadSource({ workingDirectory: configuration.workingDirectory,
            path: command.path, asZip: command.asZip, accessPolicy: configuration.accessPolicy,
            additionalAllowedReadDirs: configuration.additionalAllowedReadDirs,
            additionalAllowedReadFiles: configuration.additionalAllowedReadFiles });
          if (!resolved.success) return resolved;
          const source = resolved.source;
          const payload = createFileTransferPayloadSource({ filePath: source.filePath, name: source.name, sizeBytes: source.sizeBytes,
            ...(source.deleteFileOnClose ? { dispose: () => rm(source.filePath, { force: true }) } : {}) });
          return { success: true, ...await registerSource(payload, source.name) };
        }
        case 'download.read': {
          const source = sources.get(command.sourceId);
          if (!source) throw invalidOperation();
          const bytes = await readTransferPayloadChunk({ source, offset: command.offset, length: command.length });
          assertOpen();
          return { contentBase64: bytes.toString('base64') };
        }
        case 'download.close': {
          const source = sources.get(command.sourceId);
          sources.delete(command.sourceId);
          await disposeTransferPayloadSource(source);
          return { success: true };
        }
        case 'upload.open': {
          if (command.input.t !== 'session_file_upload_v1') throw invalidOperation();
          if (command.stageId) return await entries.openUpload(command.stageId, command.input);
          // Additional extents are host-granted in the fixed configuration,
          // never promoted from an upload's public request.
          return await uploads.openTrustedImportSession({ ...command.input,
            additionalAllowedWriteDirs: configuration.additionalAllowedWriteDirs });
        }
        case 'upload.chunk': {
          const response = await uploads.writeImportTransferChunk(command);
          return { response, expiresAt: uploads.readImportSessionExpiry(command.uploadId) };
        }
        case 'upload.finalize': return command.stageId
          ? await entries.finalizeUpload(command.stageId, command.uploadId) : await uploads.finalizeImportTransferSession(command);
        case 'upload.abort': return await uploads.abortImportTransferSession(command) ?? { aborted: true };
        case 'entry.export': return await entries.openExport(command.input);
        case 'entry.resolve': return await entries.resolveExport(command.sourceId, command.transferId);
        case 'entry.prepare': return await entries.prepare(command.input);
        case 'entry.apply': return await entries.apply(command.stageId, command.payloads);
        case 'entry.close': return await entries.close(command.stageId, command.retain);
      }
    },
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      const retained = [...sources.values()];
      sources.clear();
      const results = await Promise.allSettled([uploads.close(), rpcStore.dispose(), ...retained.map(disposeTransferPayloadSource)]);
      try { await entries.dispose(); }
      catch (error) { results.push({ status: 'rejected', reason: error }); }
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}
