import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemUploadInputSchema, FilesystemDownloadInputSchema, FilesystemTransferCancelInputSchema, FilesystemPreparedCopyInputSchema,
  type FilesystemUploadOutput, type FilesystemDownloadOutput, type FilesystemTransferCancelOutput, type FilesystemCopyOutput,
} from '@happier-dev/protocol/actions/filesystemActionFamily';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { filesystemPathComparisonKey, isFilesystemPathAbsolute, type FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { DirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { prepareWorkspaceFileExport, prepareWorkspaceEntryExport } from './prepareWorkspaceFileExport';
import { createPreparedFilesystemEntryCopyDestination } from './preparedFilesystemEntryCopyDestination';
import type { PreparedFilesystemTransferScope } from './preparedFilesystemTransferScope';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

type TransferActionId = 'daemon.filesystem.upload' | 'daemon.filesystem.download' | 'daemon.filesystem.transfer.cancel' | 'daemon.filesystem.copy';
type TransferActionOutput = FilesystemUploadOutput | FilesystemDownloadOutput | FilesystemTransferCancelOutput | FilesystemCopyOutput;

export function projectPreparedFilesystemActionResult(result: TransferActionOutput): ActionExecuteResult {
  return result.success ? { ok: true, result } : { ok: false, errorCode: result.errorCode ?? 'filesystem_transfer_failed', error: result.error };
}

export function createPreparedFilesystemTransferActionExecutor(params: Readonly<{
  admissionDrain?: Pick<DaemonAdmissionDrain, 'isQuiescing' | 'isFinalShutdown'>;
  lifecycle: DirectTransferServerLifecycle;
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs?: () => readonly string[];
  getAdditionalAllowedWriteDirs?: () => readonly string[];
}>) {
  const admittedPath = (rootPath: string, path: string, kind: 'read' | 'write' = 'write') => {
    const additionalAllowedDirs = kind === 'read' ? params.getAdditionalAllowedReadDirs?.() : params.getAdditionalAllowedWriteDirs?.();
    if (!isFilesystemPathAbsolute(rootPath)) throw new Error('Filesystem root must be absolute');
    const root = authorizeFilesystemPath({ targetPath: rootPath, defaultDirectory: params.workingDirectory, accessPolicy: params.accessPolicy, additionalAllowedDirs });
    if (!root.valid) throw new Error(root.error);
    const target = authorizeFilesystemPath({ targetPath: path, defaultDirectory: root.resolvedPath,
      accessPolicy: { kind: 'restrictedRoots', roots: [root.resolvedPath] } });
    if (!target.valid) throw new Error(target.error);
    const admitted = authorizeFilesystemPath({ targetPath: target.resolvedPath, defaultDirectory: root.resolvedPath, accessPolicy: params.accessPolicy, additionalAllowedDirs });
    if (!admitted.valid) throw new Error(admitted.error);
    return { rootPath: root.resolvedPath, path: admitted.resolvedPath };
  };
  return async (args: Readonly<{ actionId: TransferActionId; input: unknown; context: ActionExecutorContext;
    assertCurrentAuthority?: () => Promise<void> }>): Promise<TransferActionOutput> => {
    const failure = (error: string, errorCode: string): TransferActionOutput => args.actionId === 'daemon.filesystem.transfer.cancel'
      ? { success: false, error, errorCode } : transferFailure({ error, errorCode });
    const requesterAccountId = args.context.externalActionCredential?.accountId ?? args.context.runtimeAccountId;
    if (!requesterAccountId) return failure('Filesystem requester admission is unavailable', 'FILESYSTEM_REQUESTER_REQUIRED');
    let onAbort: (() => void) | undefined;
    try {
      if (args.actionId === 'daemon.filesystem.transfer.cancel') {
        const input = FilesystemTransferCancelInputSchema.parse(args.input);
        const scope = { rootPath: admittedPath(input.rootPath, input.rootPath, input.direction === 'download' ? 'read' : 'write').rootPath, requesterAccountId };
        if (input.direction === 'upload') {
          const result = await params.lifecycle.abortImportSession({ uploadId: input.transferId }, scope);
          return { success: true, aborted: result?.aborted ?? false };
        }
        return { success: true, aborted: params.lifecycle.clearPublishedTransfer(input.transferId, scope) };
      }
      // This invocation is the fresh Action front door. Once entered, its
      // awaited descriptors and settlement keep the same containing custody.
      if (params.admissionDrain?.isQuiescing()) return failure(
        params.admissionDrain.isFinalShutdown() ? 'The daemon is shutting down.' : 'The daemon is draining.',
        params.admissionDrain.isFinalShutdown() ? 'daemon_shutting_down' : 'daemon_draining');
      const acceptance = args.context.operationAcceptance;
      if (!acceptance) return { success: false, status: 'failed', error: 'Filesystem transfer operation owner is unavailable', errorCode: 'FILESYSTEM_OPERATION_OWNER_REQUIRED' };
      if (args.actionId === 'daemon.filesystem.upload' || args.actionId === 'daemon.filesystem.copy') {
        const copy = args.actionId === 'daemon.filesystem.copy' ? FilesystemPreparedCopyInputSchema.parse(args.input) : null;
        if (copy && (copy.destination.serverId !== args.context.serverId
          || args.context.externalActionTarget?.kind !== 'machine'
          || copy.destination.machineId !== args.context.externalActionTarget.machineId)) {
          return failure('Prepared copy destination does not match the admitted target', 'target_unavailable');
        }
        if (copy && !isFilesystemPathAbsolute(copy.source.rootPath)) return failure('Prepared copy source root must be absolute', 'invalid_input');
        const input = copy ? { rootPath: copy.destination.rootPath, path: copy.destination.path, overwrite: copy.overwrite,
          source: { sourceId: copy.source.sourceId, sizeBytes: copy.source.sizeBytes, sha256: copy.source.sha256 } }
          : FilesystemUploadInputSchema.parse(args.input);
        const target = admittedPath(input.rootPath, input.path);
        if (copy && filesystemPathComparisonKey(target.rootPath) === filesystemPathComparisonKey(target.path)) {
          return failure('The admitted filesystem root cannot be replaced', 'FILESYSTEM_ROOT_PROTECTED');
        }
        const scope = { rootPath: target.rootPath, requesterAccountId, sourceId: input.source.sourceId,
          assertCurrentAuthority: async () => {
            args.context.signal?.throwIfAborted();
            await args.assertCurrentAuthority?.();
            args.context.signal?.throwIfAborted();
            admittedPath(input.rootPath, input.path);
          } } satisfies PreparedFilesystemTransferScope;
        if (copy?.source.kind === 'entry_tree') {
          const entryTree = copy.source.entryTree;
          if (entryTree.expectation.kind === 'missing') return failure('Filesystem copy source is missing', 'source_missing');
          if (entryTree.expectation.kind === 'directory' && !copy.recursive) return failure('Directory copies require recursive=true', 'recursive_required');
          const custody = await mkdtemp(join(tmpdir(), 'happier-filesystem-copy-destination-'));
          const imports: Array<{ transferId: string; prepared: Awaited<ReturnType<DirectTransferServerLifecycle['prepareImportSession']>>;
            settlement: ReturnType<DirectTransferServerLifecycle['waitForImportTransferSettlement']> }> = [];
          let retainCustody = false;
          const cancelAll = async () => {
            await Promise.all(imports.map(record => params.lifecycle.abortImportSession({ uploadId: record.prepared.uploadId }, scope)));
          };
          try {
            const descriptors = [{ transferId: entryTree.operationId, sizeBytes: copy.source.sizeBytes, manifestHash: `sha256:${copy.source.sha256}` }, ...entryTree.blobs];
            if (new Set(descriptors.map(record => record.transferId)).size !== descriptors.length) return failure('Copy payload identities must be unique', 'invalid_input');
            for (const descriptor of descriptors) {
              const prepared = await params.lifecycle.prepareImportSession({ t: 'session_file_upload_v1', workingDirectory: custody,
                path: join(custody, `payload-${imports.length}`), sizeBytes: descriptor.sizeBytes,
                sha256: descriptor.manifestHash.slice('sha256:'.length), overwrite: false }, scope, custody);
              imports.push({ transferId: descriptor.transferId, prepared,
                settlement: params.lifecycle.waitForImportTransferSettlement(prepared.uploadId, scope) });
            }
            onAbort = () => { void cancelAll().catch(() => undefined); };
            args.context.signal?.addEventListener('abort', onAbort, { once: true });
            if (args.context.signal?.aborted) onAbort();
            acceptance.accept({ success: true, status: 'accepted', operationId: acceptance.operationId, sourceId: copy.source.sourceId,
              prepared: { manifest: imports[0]!.prepared, blobs: imports.slice(1).map(record => ({ transferId: record.transferId, prepared: record.prepared })) } } satisfies FilesystemCopyOutput);
            const settlements = new Map<string, Extract<Awaited<typeof imports[number]['settlement']>, { success: true }>>();
            const results = await Promise.all(imports.map(async record => {
              const result = await record.settlement;
              if (!result.success) throw Object.assign(new Error(result.error), { errorCode: result.errorCode });
              settlements.set(record.transferId, result);
            })).then(() => null, (error: unknown) => {
              const code = error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? error.errorCode : undefined;
              return { error: error instanceof Error ? error.message : 'Copy import failed', errorCode: code };
            });
            if (results) { retainCustody = results.errorCode === 'indeterminate'; await cancelAll(); return transferFailure(results); }
            await mkdir(join(custody, 'recovery'));
            const outcome = await createPreparedFilesystemEntryCopyDestination(params)({ operationId: entryTree.operationId,
              rootPath: target.rootPath, path: target.path, requesterAccountId, overwrite: copy.overwrite, recursive: copy.recursive,
              expectation: entryTree.expectation, stagingDirectory: join(custody, 'stage'), recoveryDirectory: join(custody, 'recovery'),
              requestPayload: async request => {
                const settled = settlements.get(request.transferId);
                if (!settled) throw new Error('Copy payload is outside the admitted entry commitment');
                await copyFile(settled.finalized.path, request.destinationPath);
              }, assertCurrentAuthority: scope.assertCurrentAuthority,
              ...(args.context.signal ? { signal: args.context.signal } : {}) });
            if (outcome.status === 'recovery_needed') { retainCustody = true; return failure('Filesystem copy outcome could not be confirmed; recovery custody is retained', 'indeterminate'); }
            if (outcome.status === 'restored') return failure('Filesystem copy failed and the destination was restored', 'filesystem_copy_restored');
            return { success: true, status: 'completed', sourceId: copy.source.sourceId, path: target.path, expectation: entryTree.expectation };
          } finally {
            if (!retainCustody) { await cancelAll().catch(() => undefined); await rm(custody, { recursive: true, force: true }); }
          }
        }
        const prepared = await params.lifecycle.prepareImportSession({ t: 'session_file_upload_v1', workingDirectory: target.rootPath,
          path: target.path, sizeBytes: input.source.sizeBytes, overwrite: input.overwrite,
          additionalAllowedWriteDirs: params.getAdditionalAllowedWriteDirs?.(),
          ...(input.source.sha256 ? { sha256: input.source.sha256 } : {}) }, scope);
        const settlement = params.lifecycle.waitForImportTransferSettlement(prepared.uploadId, scope);
        onAbort = () => { void params.lifecycle.abortImportSession({ uploadId: prepared.uploadId }, scope).catch(() => undefined); };
        args.context.signal?.addEventListener('abort', onAbort, { once: true });
        if (args.context.signal?.aborted) onAbort();
        acceptance.accept({ success: true, status: 'accepted', operationId: acceptance.operationId, sourceId: input.source.sourceId, prepared } satisfies FilesystemUploadOutput);
        const result = await settlement;
        if (!result.success) return transferFailure(result);
        return { success: true, status: 'completed', sourceId: input.source.sourceId, transferId: prepared.uploadId,
          path: result.finalized.path, sizeBytes: result.finalized.sizeBytes, sha256: result.sha256 };
      }
      const input = FilesystemDownloadInputSchema.parse(args.input);
      const target = admittedPath(input.rootPath, input.path, 'read');
      const scope: PreparedFilesystemTransferScope = { rootPath: target.rootPath, requesterAccountId, destinationId: input.destination.destinationId };
      const exported = input.format ? await prepareWorkspaceEntryExport({ lifecycle: params.lifecycle, accessPolicy: params.accessPolicy,
        additionalAllowedReadDirs: params.getAdditionalAllowedReadDirs?.(),
        rootPath: target.rootPath, path: target.path, operationId: acceptance.operationId, filesystemScope: scope,
        assertCurrentAuthority: async () => { args.context.signal?.throwIfAborted(); admittedPath(input.rootPath, input.path, 'read'); } }) : null;
      const prepared = exported?.prepared ?? await prepareWorkspaceFileExport({ lifecycle: params.lifecycle, accessPolicy: params.accessPolicy,
        request: { workingDirectory: target.rootPath, path: target.path, asZip: input.asZip, confinedToWorkingDirectory: true }, filesystemScope: scope });
      const settlement = params.lifecycle.waitForFilesystemExportSettlement(prepared.transferId, scope);
      onAbort = () => params.lifecycle.clearPublishedTransfer(prepared.transferId, scope);
      args.context.signal?.addEventListener('abort', onAbort, { once: true });
      if (args.context.signal?.aborted) onAbort();
      acceptance.accept({ success: true, status: 'accepted', operationId: acceptance.operationId, destinationId: input.destination.destinationId, prepared,
        ...(exported ? { entryTree: exported.entryTree } : {}) } satisfies FilesystemDownloadOutput);
      const result = await settlement;
      if (!result.success) return transferFailure(result);
      return { success: true, status: 'completed', transferId: prepared.transferId, destinationId: input.destination.destinationId,
        name: prepared.name, sizeBytes: result.sizeBytes, sha256: result.manifestHash.slice('sha256:'.length) };
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? error.errorCode
        : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'filesystem_transfer_failed';
      return failure(error instanceof Error ? error.message : 'Filesystem transfer failed', errorCode);
    } finally {
      if (onAbort) args.context.signal?.removeEventListener('abort', onAbort);
    }
  };
}

function transferFailure(result: Readonly<{ error: string; errorCode?: string }>): Extract<FilesystemUploadOutput, { success: false }> {
  return { success: false, status: result.errorCode === 'cancelled' ? 'cancelled' : result.errorCode === 'indeterminate' ? 'unknown' : 'failed',
    error: result.error, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
}
