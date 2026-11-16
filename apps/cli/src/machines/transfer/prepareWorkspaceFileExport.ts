import { randomUUID } from 'node:crypto';
import { open, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FileDownloadDestinationV1, FileDownloadResultV1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';
import { writeFileHandleFully } from '@happier-dev/transfers/node';
import { FileDownloadDestinationV1Schema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { readPortablePathSegmentViolation } from '@happier-dev/protocol/filesystem/portablePathSegment';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { currentWorkspaceSource, runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { copyWorkspaceTree } from '@/workspaces/source/copyWorkspaceTree';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM } from '@happier-dev/cli-common/firstPartyRuntime';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { observeWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';
import { captureWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncConflicts';
import { createWorkspaceSyncEntryExport } from '@/workspaces/sync/workspaceSyncEntryTransfer';

import { filesystemPathComparisonKey, type FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import { createFileTransferPayloadSource, resolveTransferPayloadManifestHash, resolveTransferPayloadSizeBytes } from './transferPayloadSource';
import type { DirectTransferServerLifecycle } from './directTransferServerLifecycle';
import type { PreparedFilesystemReadFile, PreparedFilesystemTransferScope } from './preparedFilesystemTransferScope';
import type { NativeFilesystemPayloadSource } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';

/** The existing publication record owns these acquired bytes until ACK, refusal, retirement or expiry. */
export async function prepareAcquiredFileDownload(params: Readonly<{
  lifecycle: Pick<DirectTransferServerLifecycle, 'publishTransferWhenReady' | 'clearPublishedTransfer'>;
  input: Readonly<{ name: string; bytes: Uint8Array; destination: FileDownloadDestinationV1 }>;
  sourceId: string; operationId: string; requesterAccountId: string; retirementSignal: AbortSignal; signal?: AbortSignal;
  assertCurrentAuthority: () => Promise<void>;
  onDispose?: () => Promise<void>;
}>): Promise<FileDownloadResultV1> {
  const transferId = `file-download:${randomUUID()}`;
  let directory: string | undefined;
  let disposed = false;
  const scope: PreparedFilesystemTransferScope = { kind: 'acquired', sourceId: params.sourceId,
    requesterAccountId: params.requesterAccountId, destinationId: params.input.destination.destinationId };
  const retire = () => { params.lifecycle.clearPublishedTransfer(transferId, scope); };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    params.retirementSignal.removeEventListener('abort', retire);
    try { if (directory) await removeHappierTempDirAsync(directory); }
    finally { await params.onDispose?.(); }
  };
  const assertCurrent = async () => {
    try {
      params.retirementSignal.throwIfAborted();
      await params.assertCurrentAuthority();
      params.retirementSignal.throwIfAborted();
    } catch (error) { retire(); throw error; }
  };
  try {
    FileDownloadDestinationV1Schema.parse(params.input.destination);
    if (!params.input.name || readPortablePathSegmentViolation(params.input.name) !== null || !(params.input.bytes instanceof Uint8Array)) {
      throw new Error('Invalid acquired file');
    }
    params.signal?.throwIfAborted();
    await assertCurrent();
    // Snapshot before source-file I/O so the published manifest and bytes agree.
    const bytes = params.input.bytes.slice();
    const manifestHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    directory = createHappierTempDir({ purpose: 'file-download-source' });
    const filePath = resolve(directory, 'payload');
    await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    params.signal?.throwIfAborted();
    await assertCurrent();
    const payloadSource = { ...createFileTransferPayloadSource({ filePath, name: params.input.name,
      sizeBytes: bytes.byteLength, manifestHash, dispose }), assertCurrentAuthority: assertCurrent };
    const published = await params.lifecycle.publishTransferWhenReady({ transferId, payloadSource, filesystemScope: scope });
    params.signal?.throwIfAborted();
    params.retirementSignal.addEventListener('abort', retire, { once: true });
    if (params.retirementSignal.aborted) { retire(); throw params.retirementSignal.reason; }
    return { success: true, status: 'accepted', operationId: params.operationId, destinationId: params.input.destination.destinationId,
      prepared: { transferId, name: params.input.name, sizeBytes: bytes.byteLength, manifestHash,
        expiresAt: published.expiresAt, endpointCandidates: [...published.endpointCandidates] } };
  } catch (error) {
    retire();
    await dispose();
    return { success: false, status: params.signal?.aborted || params.retirementSignal.aborted ? 'cancelled' : 'failed',
      errorCode: params.signal?.aborted || params.retirementSignal.aborted ? 'cancelled' : 'file_download_unavailable',
      error: error instanceof Error ? error.message : 'File download unavailable' };
  }
}

/** One source/ZIP preparation owner for raw prepared exports and filesystem Actions. */
export async function prepareWorkspaceFileExport(params: Readonly<{
  lifecycle: Pick<DirectTransferServerLifecycle, 'publishTransferWhenReady'>;
  accessPolicy?: FilesystemAccessPolicy;
  request: Readonly<{ workingDirectory: string; path: string; asZip: boolean; confinedToWorkingDirectory?: boolean }>;
  filesystemScope?: PreparedFilesystemTransferScope;
  nativeDownload?: (input: Readonly<{ path: string; asZip: boolean }>) => Promise<NativeFilesystemPayloadSource>;
}>) {
  await params.filesystemScope?.assertCurrentAuthority?.();
  const nativeDownload = params.nativeDownload;
  const source = nativeDownload ? await (async () => {
    const payloadSource = await nativeDownload(params.request);
    return { payloadSource, name: payloadSource.name, sizeBytes: payloadSource.sizeBytes };
  })() : await (async () => {
    const resolved = await resolveWorkspaceFileDownloadSource({ ...params.request,
      accessPolicy: params.accessPolicy, sessionRpcTransferMaxBytes: null });
    if (!resolved.success) throw new Error(resolved.error);
    const file = resolved.source;
    return { name: file.name, sizeBytes: file.sizeBytes, payloadSource: createFileTransferPayloadSource({ filePath: file.filePath,
      sizeBytes: file.sizeBytes, name: file.name,
      ...(file.deleteFileOnClose ? { dispose: () => rm(file.filePath, { force: true }) } : {}) }) };
  })();
  const payloadSource = source.payloadSource;
  try {
    const manifestHash = await resolveTransferPayloadManifestHash(payloadSource);
    await params.filesystemScope?.assertCurrentAuthority?.();
    const published = await params.lifecycle.publishTransferWhenReady({
      transferId: `workspace-file-download:${randomUUID()}`, payloadSource: { ...payloadSource, manifestHash },
      ...(params.filesystemScope ? { filesystemScope: params.filesystemScope } : {}),
    });
    return { transferId: published.transferId, endpointCandidates: published.endpointCandidates,
      expiresAt: published.expiresAt, name: source.name, sizeBytes: source.sizeBytes, manifestHash };
  } catch (error) {
    await payloadSource.dispose?.();
    throw error;
  }
}

/** Use the exact acquired descriptor once, then retain the incumbent private snapshot. */
async function captureAdmittedReadFile(input: Readonly<{
  readFile: PreparedFilesystemReadFile;
  rootPath: string;
  path: string;
  captureDirectory: string;
  assertCurrentAuthority: () => Promise<void>;
}>): Promise<Readonly<{ materialPath: string; expectation: WorkspaceSyncEntryExpectationV1 }>> {
  const source = input.readFile;
  const refuse = (): never => { throw Object.assign(new Error('The acquired file no longer matches its admitted bytes'), {
    code: 'filesystem_transfer_custody_required',
  }); };
  try {
    if (filesystemPathComparisonKey(source.rootPath) !== filesystemPathComparisonKey(input.rootPath)
      || filesystemPathComparisonKey(source.path) !== filesystemPathComparisonKey(input.path)) return refuse();
    await input.assertCurrentAuthority();
    const before = await source.handle.stat();
    if (!before.isFile() || before.size !== source.sizeBytes) return refuse();
    const materialPath = resolve(input.captureDirectory, 'entry');
    const destination = await open(materialPath, 'wx', 0o600);
    const sha256 = createHash('sha256');
    const digest = createHash(MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM);
    let size = 0;
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (size < source.sizeBytes) {
        const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, source.sizeBytes - size), size);
        if (bytesRead === 0) return refuse();
        const bytes = buffer.subarray(0, bytesRead);
        sha256.update(bytes);
        digest.update(bytes);
        await writeFileHandleFully({ fileHandle: destination, buffer: bytes, position: size });
        size += bytesRead;
      }
      await destination.chmod(before.mode & 0o777);
    } finally { await destination.close(); }
    const after = await source.handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode || sha256.digest('hex') !== source.sha256) return refuse();
    await input.assertCurrentAuthority();
    return { materialPath, expectation: { kind: 'file', digest: digest.digest('hex'), executable: (before.mode & 0o111) !== 0, size } };
  } finally { await source.handle.close(); }
}

type WorkspaceEntryExportParams = Readonly<{
  rootPath: string; path: string; operationId: string;
  accessPolicy: FilesystemAccessPolicy;
  additionalAllowedReadDirs?: readonly string[];
  assertCurrentAuthority: () => Promise<void>;
  admittedReadFile?: PreparedFilesystemReadFile;
}>;

/** Capture entry bytes at their native owner before the host publishes them. */
export async function createWorkspaceEntryExportSource(params: WorkspaceEntryExportParams) {
  const relativePath = relative(params.rootPath, params.path);
  if (!relativePath) throw new Error('The filesystem root cannot be exported as a copy entry');
  await params.assertCurrentAuthority();
  const workspace = currentWorkspaceSource();
  if (workspace.kind !== 'local' && !params.admittedReadFile) {
    // A target entry is first copied into host staging through the port; the same
    // confined capture/export owner then exports it from that staged root.
    const stagingRoot = createHappierTempDir({ purpose: 'filesystem-copy-target-source' });
    try {
      await copyWorkspaceTree({ from: { source: workspace, path: params.path }, to: { source: localWorkspaceSource, path: join(stagingRoot, relativePath) } });
      const exported = await runWithWorkspaceSource(localWorkspaceSource, () => captureLocalWorkspaceEntryExport({ ...params,
        rootPath: stagingRoot, path: join(stagingRoot, relativePath), accessPolicy: { kind: 'restrictedRoots', roots: [stagingRoot] } }));
      const release = exported.payloadSource.dispose;
      return { ...exported, payloadSource: { ...exported.payloadSource,
        dispose: async () => { try { await release?.(); } finally { await removeHappierTempDirAsync(stagingRoot); } } } };
    } catch (error) { await removeHappierTempDirAsync(stagingRoot); throw error; }
  }
  return await captureLocalWorkspaceEntryExport(params);
}

async function captureLocalWorkspaceEntryExport(params: WorkspaceEntryExportParams) {
  const relativePath = relative(params.rootPath, params.path);
  const captureDirectory = createHappierTempDir({ purpose: 'filesystem-copy-source' });
  try {
    const captured = params.admittedReadFile ? await captureAdmittedReadFile({ readFile: params.admittedReadFile,
      rootPath: params.rootPath, path: params.path, captureDirectory, assertCurrentAuthority: params.assertCurrentAuthority })
      : await (async () => {
        const expectation = await observeWorkspaceSyncEntryAtRoot({ rootPath: params.rootPath, relativePath,
          assertCurrentAuthority: params.assertCurrentAuthority });
        if (expectation.kind === 'missing') throw new Error('Filesystem copy source is missing');
        return await captureWorkspaceSyncEntryAtRoot({ rootPath: params.rootPath, relativePath,
          expected: expectation, captureDirectory, operationId: params.operationId, assertCurrentAuthority: params.assertCurrentAuthority });
      })();
    const expectation = captured.expectation;
    const exported = await createWorkspaceSyncEntryExport({ operationId: params.operationId,
      expectation, materialPath: captured.materialPath,
      assertEntryAllowed: entry => {
        if (entry.kind !== 'symlink') return;
        const originalPath = resolve(params.path, ...entry.relativePath.split('/').slice(1));
        // Link targets are filesystem bytes, not shell/home expressions.
        const destination = resolve(dirname(originalPath), entry.target);
        const confined = authorizeFilesystemPath({ targetPath: destination, defaultDirectory: params.rootPath,
          accessPolicy: { kind: 'restrictedRoots', roots: [params.rootPath] } });
        const admitted = authorizeFilesystemPath({ targetPath: destination, defaultDirectory: params.rootPath, accessPolicy: params.accessPolicy,
          additionalAllowedDirs: params.additionalAllowedReadDirs });
        const denied = !confined.valid ? confined : !admitted.valid ? admitted : null;
        if (denied) throw Object.assign(new Error('Filesystem copy source link escapes its admitted root'), { code: denied.errorCode });
      } });
    const payloadSource = { ...exported.payloadSource, dispose: () => removeHappierTempDirAsync(captureDirectory) };
    const manifestHash = await resolveTransferPayloadManifestHash(payloadSource);
    const sizeBytes = await resolveTransferPayloadSizeBytes(payloadSource);
    await params.assertCurrentAuthority();
    return { payloadSource, onDemandScope: exported.onDemandScope, name: basename(params.path), sizeBytes, manifestHash,
      entryTree: { operationId: params.operationId, expectation, blobs: [...exported.blobs] } };
  } catch (error) {
    await removeHappierTempDirAsync(captureDirectory);
    throw error;
  }
}

/** Publish the same captured entry through the incumbent mounted lifecycle. */
export async function prepareWorkspaceEntryExport(params: Parameters<typeof createWorkspaceEntryExportSource>[0] & Readonly<{
  lifecycle: Pick<DirectTransferServerLifecycle, 'publishTransferWhenReady'>;
  filesystemScope: PreparedFilesystemTransferScope;
  nativeExport?: () => ReturnType<typeof createWorkspaceEntryExportSource>;
}>) {
  const exported = await (params.nativeExport?.() ?? createWorkspaceEntryExportSource(params));
  try {
    const published = await params.lifecycle.publishTransferWhenReady({ transferId: params.operationId,
      payloadSource: exported.payloadSource, onDemandScope: exported.onDemandScope, filesystemScope: params.filesystemScope });
    return { prepared: { transferId: published.transferId, endpointCandidates: published.endpointCandidates,
      expiresAt: published.expiresAt, name: exported.name, sizeBytes: exported.sizeBytes, manifestHash: exported.manifestHash },
      entryTree: exported.entryTree };
  } catch (error) { await exported.payloadSource.dispose?.(); throw error; }
}
