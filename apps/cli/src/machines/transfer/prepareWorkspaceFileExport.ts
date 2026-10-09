import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
}>) {
  const resolved = await resolveWorkspaceFileDownloadSource({ ...params.request,
    accessPolicy: params.accessPolicy, sessionRpcTransferMaxBytes: null });
  if (!resolved.success) throw new Error(resolved.error);
  const source = resolved.source;
  const payloadSource = createFileTransferPayloadSource({ filePath: source.filePath,
    sizeBytes: source.sizeBytes, name: source.name,
    ...(source.deleteFileOnClose ? { dispose: () => rm(source.filePath, { force: true }) } : {}) });
  try {
    const manifestHash = await resolveTransferPayloadManifestHash(payloadSource);
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
export async function prepareWorkspaceEntryExport(params: Readonly<{
  lifecycle: Pick<DirectTransferServerLifecycle, 'publishTransferWhenReady'>;
  rootPath: string; path: string; operationId: string;
  accessPolicy: FilesystemAccessPolicy;
  additionalAllowedReadDirs?: readonly string[];
  filesystemScope: PreparedFilesystemTransferScope;
  assertCurrentAuthority: () => Promise<void>;
}>) {
  const relativePath = relative(params.rootPath, params.path);
  if (!relativePath) throw new Error('The filesystem root cannot be exported as a copy entry');
  await params.assertCurrentAuthority();
  const expectation = await observeWorkspaceSyncEntryAtRoot({ rootPath: params.rootPath, relativePath,
    assertCurrentAuthority: params.assertCurrentAuthority });
  if (expectation.kind === 'missing') throw new Error('Filesystem copy source is missing');
  const captureDirectory = await mkdtemp(join(tmpdir(), 'happier-filesystem-copy-source-'));
  try {
    const captured = await captureWorkspaceSyncEntryAtRoot({ rootPath: params.rootPath, relativePath,
      expected: expectation, captureDirectory, assertCurrentAuthority: params.assertCurrentAuthority });
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
        if (!confined.valid || !admitted.valid) throw new Error('Filesystem copy source link escapes its admitted root');
      } });
    const payloadSource = { ...exported.payloadSource, dispose: () => rm(captureDirectory, { recursive: true, force: true }) };
    const manifestHash = await resolveTransferPayloadManifestHash(payloadSource);
    const sizeBytes = await resolveTransferPayloadSizeBytes(payloadSource);
    await params.assertCurrentAuthority();
    const published = await params.lifecycle.publishTransferWhenReady({ transferId: params.operationId,
      payloadSource, onDemandScope: exported.onDemandScope, filesystemScope: params.filesystemScope });
    return { prepared: { transferId: published.transferId, endpointCandidates: published.endpointCandidates,
      expiresAt: published.expiresAt, name: basename(params.path), sizeBytes, manifestHash },
      entryTree: { operationId: params.operationId, expectation, blobs: [...exported.blobs] } };
  } catch (error) {
    await rm(captureDirectory, { recursive: true, force: true });
    throw error;
  }
}
