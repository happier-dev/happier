import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { assembleArtifactHtmlBundleV1, isArtifactHtmlBundleEntrypointV1, prepareArtifactWorkspaceFileV1 } from '@happier-dev/protocol/artifacts/artifactWorkspaceFileV1';
import type { ArtifactSavedByV1 } from '@happier-dev/protocol';
import type { UiSurfaceCapabilityRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { configuration } from '@/configuration';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createTransferSessionLifecycle } from '@happier-dev/transfers/node';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import { resolveWorkspaceFileUploadTarget } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';
import { validatePath } from '@/rpc/handlers/pathSecurity';

export type ArtifactSessionWorkspaceCaller = Readonly<{ sessionId: string; machineId: string; directory: string; runId?: string; rootPath?: never }>;
export type ArtifactWorkspaceCaller = ArtifactSessionWorkspaceCaller
  | Readonly<{ rootPath: string; machineId: string; directory: string; sessionId?: never; runId?: never }>;

/** Account bytes use the incumbent confined upload target and transfer finalizer. */
export async function writeArtifactWorkspaceFile(params: Readonly<{
  caller: ArtifactSessionWorkspaceCaller;
  path: string;
  overwrite?: boolean;
  bytes: Uint8Array;
  sha256: string;
  signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  if (!params.caller.sessionId || !params.caller.machineId || !isAbsolute(params.caller.directory)) {
    throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
  }
  const resolved = resolveWorkspaceFileUploadTarget({ workingDirectory: params.caller.directory,
    path: params.path, sizeBytes: params.bytes.byteLength, overwrite: params.overwrite ?? false,
    accessPolicy: { kind: 'restrictedRoots', roots: [params.caller.directory] } });
  if (!resolved.success) throw Object.assign(new Error('artifact_destination_forbidden'), { code: 'artifact_destination_forbidden' });
  const transfers = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
  const lifecycle = createTransferSessionLifecycle({ store: transfers, chunkSizeBytes: configuration.filesTransferChunkBytes });
  try {
    const session = await lifecycle.openUploadTransferSession({ target: resolved.target, sha256Expected: params.sha256 });
    for (let offset = 0, index = 0; offset < params.bytes.byteLength; offset += session.chunkSizeBytes, index += 1) {
      params.signal?.throwIfAborted();
      const chunk = await lifecycle.writeUploadTransferChunk({ uploadId: session.uploadId, index,
        contentBase64: Buffer.from(params.bytes.subarray(offset, offset + session.chunkSizeBytes)).toString('base64') });
      if (!chunk.success) throw Object.assign(new Error('artifact_destination_transfer_failed'), { code: 'artifact_destination_transfer_failed' });
    }
    params.signal?.throwIfAborted();
    const result = await lifecycle.finalizeUploadTransferSession({ uploadId: session.uploadId });
    if (!result.success) {
      const code = result.errorCode ?? 'artifact_destination_transfer_failed';
      throw Object.assign(new Error(code), { code });
    }
    return { path: relative(params.caller.directory, resolved.target.destPath).split(sep).join('/'), sizeBytes: params.bytes.byteLength };
  } finally { await transfers.dispose(); }
}

/** Every Artifact file input uses the same confined workspace transfer owner and its byte budget. */
export async function readArtifactWorkspaceFile(params: Readonly<{
  caller: ArtifactWorkspaceCaller;
  path: string;
  entrypoint?: string;
  mime?: string;
  kind?: string;
  title?: string;
  requestedCapabilities?: UiSurfaceCapabilityRequestV1;
  signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  if ((!params.caller.sessionId && !params.caller.rootPath) || !params.caller.machineId || !isAbsolute(params.caller.directory)) {
    throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
  }
  const forbidden = () => Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
  if (params.path.split(/[\\/]/u).includes('..')) throw forbidden();
  const authorized = validatePath(params.path, params.caller.directory, [],
    { kind: 'restrictedRoots', roots: [params.caller.directory] });
  if (!authorized.valid || !authorized.resolvedPath) throw forbidden();
  const sourcePath = authorized.resolvedPath;
  const sourceRelativePath = relative(params.caller.directory, sourcePath);
  // Realpath containment alone allows in-root symlinks. Publication refuses every link
  // component within the proven root rather than copying a link's mutable destination.
  let componentPath = params.caller.directory;
  if ((await lstat(componentPath)).isSymbolicLink()) throw forbidden();
  for (const component of sourceRelativePath.split(sep).filter(Boolean)) {
    componentPath = join(componentPath, component);
    params.signal?.throwIfAborted();
    if ((await lstat(componentPath)).isSymbolicLink()) throw forbidden();
  }
  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isSymbolicLink() || (!sourceStats.isFile() && !sourceStats.isDirectory())) throw forbidden();
  if (sourceStats.isDirectory()) {
    if (params.entrypoint === undefined || !isArtifactHtmlBundleEntrypointV1(params.entrypoint)) throw forbidden();
    try {
      if (!(await lstat(join(sourcePath, ...params.entrypoint.split('/')))).isFile()) throw forbidden();
    } catch {
      params.signal?.throwIfAborted();
      throw forbidden();
    }
  }
  params.signal?.throwIfAborted();
  const transfers = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
  const lifecycle = createTransferSessionLifecycle({ store: transfers, chunkSizeBytes: configuration.filesTransferChunkBytes });
  try {
    const readFile = async (path: string) => {
      params.signal?.throwIfAborted();
      const resolved = await resolveWorkspaceFileDownloadSource({ workingDirectory: params.caller.directory,
        path, asZip: false, confinedToWorkingDirectory: true });
      if (!resolved.success) throw forbidden();
      params.signal?.throwIfAborted();
      const session = await lifecycle.openDownloadTransferSession({ source: resolved.source });
      const chunks: Buffer[] = [];
      let index = 0;
      for (;;) {
        params.signal?.throwIfAborted();
        const chunk = await lifecycle.readDownloadTransferChunk({ downloadId: session.downloadId, index });
        if (!chunk.success || !('contentBase64' in chunk)) {
          throw Object.assign(new Error('artifact_source_transfer_failed'), { code: 'artifact_source_transfer_failed' });
        }
        chunks.push(Buffer.from(chunk.contentBase64, 'base64'));
        if (chunk.isLast) break;
        index += 1;
      }
      await lifecycle.finalizeDownloadTransferSession({ downloadId: session.downloadId });
      params.signal?.throwIfAborted();
      return Buffer.concat(chunks);
    };
    const metadata = { name: basename(sourcePath), path: sourceRelativePath.split(sep).join('/') || '.' };
    if (sourceStats.isFile()) {
      if (params.entrypoint !== undefined) throw forbidden();
      const bytes = await readFile(sourcePath);
      const file = { ...metadata, bytes, sha: createHash('sha256').update(bytes).digest('hex') };
      const prepared = prepareArtifactWorkspaceFileV1({ caller: params.caller, file, input: params });
      return { ...file, bundle: prepared.bundle, content: prepared };
    }
    const files: Array<Readonly<{ key: string; bytes: Uint8Array }>> = [];
    const visit = async (directory: string): Promise<void> => {
      params.signal?.throwIfAborted();
      const entries = (await readdir(directory)).sort();
      for (const entry of entries) {
        params.signal?.throwIfAborted();
        const path = join(directory, entry);
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) throw forbidden();
        if (stats.isDirectory()) { await visit(path); continue; }
        if (!stats.isFile()) throw forbidden();
        files.push({ key: relative(sourcePath, path).split(sep).join('/'), bytes: await readFile(path) });
      }
    };
    await visit(sourcePath);
    params.signal?.throwIfAborted();
    const bundle = assembleArtifactHtmlBundleV1({ entrypoint: params.entrypoint!, files });
    const bytes = Buffer.from(JSON.stringify(bundle), 'utf8');
    const file = { ...metadata, bytes, sha: createHash('sha256').update(bytes).digest('hex'), bundle };
    return { ...file, content: prepareArtifactWorkspaceFileV1({ caller: params.caller, file, input: params }) };
  } finally {
    await transfers.dispose();
  }
}

export async function publishArtifactFromWorkspaceFile(params: Readonly<{
  store: ReturnType<typeof createAccountArtifactStore>;
  caller: ArtifactWorkspaceCaller;
  input: Readonly<{ path: string; entrypoint?: string; title?: string; mime?: string; kind?: string;
    requestedCapabilities?: UiSurfaceCapabilityRequestV1 }>;
  savedBy?: ArtifactSavedByV1;
  signal?: AbortSignal;
}>) {
  const file = await readArtifactWorkspaceFile({ caller: params.caller, ...params.input, signal: params.signal });
  const { bundle: _bundle, ...content } = file.content;
  params.signal?.throwIfAborted();
  return params.store.create({ ...content,
    savedBy: params.savedBy,
    ...(params.signal ? { signal: params.signal } : {}) });
}
