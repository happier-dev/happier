import type { NativeFilesystemPayloadSource } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import type { PreparedFilesystemReadFile } from './preparedFilesystemTransferScope';
import type { WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';
import { filesystemPathComparisonKey } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM } from '@happier-dev/cli-common/firstPartyRuntime';
import { writeFileHandleFully } from '@happier-dev/transfers/node';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { observeWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';
import { captureWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncConflicts';
import { createWorkspaceSyncEntryExport } from '@/workspaces/sync/workspaceSyncEntryTransfer';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import { createFileTransferPayloadSource, resolveTransferPayloadManifestHash, resolveTransferPayloadSizeBytes } from './transferPayloadSource';
import type { DirectTransferServerLifecycle } from './directTransferServerLifecycle';
import type { PreparedFilesystemTransferScope } from './preparedFilesystemTransferScope';

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

/** Publish the existing captured entry manifest and its authorized on-demand blobs. */
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

export async function createWorkspaceEntryExportSource(params: Readonly<{
  rootPath: string; path: string; operationId: string;
  accessPolicy: FilesystemAccessPolicy;
  additionalAllowedReadDirs?: readonly string[];
  assertCurrentAuthority: () => Promise<void>;
  admittedReadFile?: PreparedFilesystemReadFile;
}>) {
  const relativePath = relative(params.rootPath, params.path);
  if (!relativePath) throw new Error('The filesystem root cannot be exported as a copy entry');
  await params.assertCurrentAuthority();
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
