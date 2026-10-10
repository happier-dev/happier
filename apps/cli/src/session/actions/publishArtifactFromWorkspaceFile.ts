import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { prepareArtifactWorkspaceFileV1 } from '@happier-dev/protocol/artifacts/artifactWorkspaceFileV1';
import { ArtifactHtmlBundleV1Schema, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { resolveHostedWebAssetContentTypeV1 } from '@happier-dev/protocol/plugins/ui/hostedWebAssetMime';
import type { ArtifactSavedByV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createTransferSessionLifecycle } from '@happier-dev/transfers/node';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import { validatePath } from '@/rpc/handlers/pathSecurity';

export type ArtifactWorkspaceCaller = Readonly<{ sessionId: string; machineId: string; directory: string; runId?: string }>;

/** Every Artifact file input uses the same confined workspace transfer owner and its byte budget. */
export async function readArtifactWorkspaceFile(params: Readonly<{
  caller: ArtifactWorkspaceCaller;
  path: string;
  entrypoint?: string;
  mime?: string;
  kind?: string;
  title?: string;
  signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  if (!params.caller.sessionId || !params.caller.machineId || !isAbsolute(params.caller.directory)) {
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
    const entrypoint = ArtifactHtmlBundleV1Schema.shape.entrypoint.safeParse(params.entrypoint);
    if (!entrypoint.success || resolveHostedWebAssetContentTypeV1(entrypoint.data)?.split(';', 1)[0] !== 'text/html') throw forbidden();
    try {
      if (!(await lstat(join(sourcePath, ...entrypoint.data.split('/')))).isFile()) throw forbidden();
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
    const files: ArtifactHtmlBundleV1['files'] = {};
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
        const key = relative(sourcePath, path).split(sep).join('/');
        if (!ArtifactHtmlBundleV1Schema.shape.entrypoint.safeParse(key).success) throw forbidden();
        const mime = resolveHostedWebAssetContentTypeV1(key)?.split(';', 1)[0] ?? 'application/octet-stream';
        files[key] = { mime, contentBase64: (await readFile(path)).toString('base64') };
      }
    };
    await visit(sourcePath);
    params.signal?.throwIfAborted();
    const parsed = ArtifactHtmlBundleV1Schema.safeParse({ v: 1, entrypoint: params.entrypoint, files });
    if (!parsed.success) throw forbidden();
    const bundle = parsed.data;
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
  input: Readonly<{ path: string; entrypoint?: string; title?: string; mime?: string; kind?: string }>;
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
