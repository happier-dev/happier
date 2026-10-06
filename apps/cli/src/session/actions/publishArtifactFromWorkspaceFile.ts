import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { prepareArtifactWorkspaceFileV1 } from '@happier-dev/protocol/artifacts/artifactWorkspaceFileV1';
import type { ArtifactSavedByV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createTransferSessionLifecycle } from '@happier-dev/transfers/node';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';

export type ArtifactWorkspaceCaller = Readonly<{ sessionId: string; machineId: string; directory: string; runId?: string }>;

/** Every Artifact file input uses the same confined workspace transfer owner and its byte budget. */
export async function readArtifactWorkspaceFile(params: Readonly<{
  caller: ArtifactWorkspaceCaller;
  path: string;
  signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  if (!params.caller.sessionId || !params.caller.machineId || !isAbsolute(params.caller.directory)) {
    throw Object.assign(new Error('artifact_source_unavailable'), { code: 'artifact_source_unavailable' });
  }
  const resolved = await resolveWorkspaceFileDownloadSource({ workingDirectory: params.caller.directory,
    path: params.path, asZip: false, confinedToWorkingDirectory: true });
  if (!resolved.success) throw Object.assign(new Error('artifact_source_forbidden'), { code: 'artifact_source_forbidden' });
  params.signal?.throwIfAborted();
  const transfers = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
  const lifecycle = createTransferSessionLifecycle({ store: transfers, chunkSizeBytes: configuration.filesTransferChunkBytes });
  try {
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
    const bytes = Buffer.concat(chunks);
    return { bytes, name: resolved.source.name, path: relative(params.caller.directory, resolved.source.filePath) };
  } finally {
    await transfers.dispose();
  }
}

export async function publishArtifactFromWorkspaceFile(params: Readonly<{
  store: ReturnType<typeof createAccountArtifactStore>;
  caller: ArtifactWorkspaceCaller;
  input: Readonly<{ path: string; title?: string; mime?: string; kind?: string }>;
  savedBy?: ArtifactSavedByV1;
  signal?: AbortSignal;
}>) {
  const file = await readArtifactWorkspaceFile({ caller: params.caller, path: params.input.path, signal: params.signal });
  return params.store.create({ ...prepareArtifactWorkspaceFileV1({ caller: params.caller, input: params.input,
    file: { ...file, sha: createHash('sha256').update(file.bytes).digest('hex') } }),
    savedBy: params.savedBy,
    ...(params.signal ? { signal: params.signal } : {}) });
}
