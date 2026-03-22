import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionHandoffProviderBundleSchema,
  TransferEndpointCandidateSchema,
  WorkspaceManifestSchema,
  type SessionHandoffProviderBundle as ProtocolSessionHandoffProviderBundle,
} from '@happier-dev/protocol';
import { type TransferPayloadCodec } from '../../../machines/transfer/transferPayloadCodec';
import { createFileTransferPayloadSource, type TransferPayloadSource } from '../../../machines/transfer/transferPayloadSource';
import {
  createScmSourceControllerWorkspaceExportArtifacts,
  cloneScmSourceControllerWorkspaceExportManifest,
  type ScmSourceControllerWorkspaceExportArtifacts,
} from '../../../scm/sourceController/workspaceExportArtifacts';
import type { WorkspaceExportBlobProvider } from '../../../scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createWorkspaceReplicationCasStore } from '../../../workspaces/replication/cas/workspaceReplicationCasStore';
import { createSessionHandoffProviderBundlePayloadSource } from '../sessionHandoffProviderBundleFile';
import type { SessionHandoffProviderBundleTransferPublication } from '../sessionHandoffProviderBundleTransferPublication';
import type { SessionHandoffWorkspaceReplicationDirectPeerPublication } from '../workspace/sessionHandoffWorkspaceReplicationDirectPeer';
import type { SessionHandoffWorkspaceReplicationMetadata } from '../workspace/sessionHandoffWorkspaceReplicationMetadata';
import type { SessionHandoffProviderBundle } from '../types';
import {
  createSessionHandoffMetadataV2,
  parseSessionHandoffMetadataV2,
  type SessionHandoffMetadataV2,
} from './sessionHandoffMetadataV2';
import {
  parseSessionHandoffTransferredCompatibilityPayloadBuffer,
  type SessionHandoffTransferredBundlesCompatibilityPayload,
} from './sessionHandoffTransferredBundlesCompatibility';

export type SessionHandoffTransferredBundles = Readonly<{
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>;

const SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC = Buffer.from('HHB1', 'utf8');

type SessionHandoffTransferredBundlesBinaryHeader = Readonly<{
  providerBundle?: ProtocolSessionHandoffProviderBundle;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  workspaceReplicationSourceRootPath?: string;
  workspaceArtifacts?: Readonly<{
    manifest: ScmSourceControllerWorkspaceExportArtifacts['manifest'];
    blobs: readonly Readonly<{
      digest: string;
      sizeBytes: number;
    }>[];
    sourceControllerMetadata?: Readonly<Record<string, unknown>>;
  }>;
  workspaceReplicationDirectPeerPublication?: SessionHandoffWorkspaceReplicationDirectPeerPublication;
}>;

type SessionHandoffTransferredBundlesPayloadSourceOptions = Readonly<{
  blobProvider?: WorkspaceExportBlobProvider;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  includeWorkspaceBlobPayloads?: boolean;
}>;

export type ReceivedSessionHandoffTransferredBundlesPayloadFile = Readonly<{
  transferredBundles: SessionHandoffTransferredBundles;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  providerBundlePayloadSource?: TransferPayloadSource;
  blobProvider?: WorkspaceExportBlobProvider;
}>;

function createCanonicalWorkspaceOnlyTransferredBundles(
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts | null,
): SessionHandoffTransferredBundles {
  return createSessionHandoffTransferredBundles({
    ...(workspaceExportArtifacts
      ? {
          workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
            manifest: workspaceExportArtifacts.manifest,
            blobContentsByDigest: new Map(),
            sourceControllerMetadata: workspaceExportArtifacts.sourceControllerMetadata ?? null,
          }),
        }
      : {}),
  });
}

async function materializeInlineWorkspaceBlobsIntoCas(params: Readonly<{
  activeServerDir: string;
  workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
}>): Promise<WorkspaceExportBlobProvider | undefined> {
  if (params.workspaceExportArtifacts.blobContentsByDigest.size === 0) {
    return undefined;
  }

  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: params.activeServerDir,
  });
  const tempDir = join(tmpdir(), 'happier-session-handoff-transfers');
  await mkdir(tempDir, { recursive: true });

  for (const [digest, content] of params.workspaceExportArtifacts.blobContentsByDigest.entries()) {
    const tempPath = join(tempDir, `handoff-inline-${randomUUID()}.blob`);
    await writeFile(tempPath, content, { mode: 0o600 });
    try {
      await casStore.commitFile({
        digest,
        sourcePath: tempPath,
      });
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  return {
    getBlobFilePath: (digest) => casStore.resolveBlobPath(digest),
  } satisfies WorkspaceExportBlobProvider;
}

export async function normalizeCurrentSessionHandoffTransferredPayloadForStorage(input: Readonly<{
  activeServerDir: string;
  transferredBundles: SessionHandoffTransferredBundles;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  providerBundlePayloadSource?: TransferPayloadSource;
  blobProvider?: WorkspaceExportBlobProvider;
}>): Promise<ReceivedSessionHandoffTransferredBundlesPayloadFile> {
  const workspaceExportArtifacts = input.transferredBundles.workspaceExportArtifacts;
  const canonicalTransferredBundles = createCanonicalWorkspaceOnlyTransferredBundles(workspaceExportArtifacts);
  const blobProvider =
    input.blobProvider
    ?? (workspaceExportArtifacts
      ? await materializeInlineWorkspaceBlobsIntoCas({
          activeServerDir: input.activeServerDir,
          workspaceExportArtifacts,
        })
      : undefined);

  return {
    transferredBundles: canonicalTransferredBundles,
    ...(input.handoffMetadataV2 ? { handoffMetadataV2: input.handoffMetadataV2 } : {}),
    ...(input.providerBundlePayloadSource ? { providerBundlePayloadSource: input.providerBundlePayloadSource } : {}),
    ...(blobProvider ? { blobProvider } : {}),
  };
}

async function projectSeparatedProviderBundlePayloadSource(
  transferredBundles: SessionHandoffTransferredBundlesCompatibilityPayload,
): Promise<Readonly<{
  transferredBundles: SessionHandoffTransferredBundles;
  providerBundlePayloadSource?: TransferPayloadSource;
}>> {
  const providerBundlePayloadSource = transferredBundles.providerBundle
    ? await createSessionHandoffProviderBundlePayloadSource(transferredBundles.providerBundle)
    : undefined;
  return {
    transferredBundles: createSessionHandoffTransferredBundles({
      ...(transferredBundles.workspaceExportArtifacts
        ? { workspaceExportArtifacts: transferredBundles.workspaceExportArtifacts }
        : {}),
    }),
    ...(providerBundlePayloadSource
      ? { providerBundlePayloadSource }
      : {}),
  };
}

export function mergeSessionHandoffTransferredBundles(input: Readonly<{
  current?: SessionHandoffTransferredBundles | null;
  incoming: SessionHandoffTransferredBundles;
}>): SessionHandoffTransferredBundles {
  return createSessionHandoffTransferredBundles({
    ...(input.incoming.workspaceExportArtifacts
      ? { workspaceExportArtifacts: input.incoming.workspaceExportArtifacts }
      : input.current?.workspaceExportArtifacts
        ? { workspaceExportArtifacts: input.current.workspaceExportArtifacts }
      : {}),
  });
}

export function createSessionHandoffTransferredBundles(params: Readonly<{
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>): SessionHandoffTransferredBundles {
  return {
    ...(params.workspaceExportArtifacts ? { workspaceExportArtifacts: params.workspaceExportArtifacts } : {}),
  };
}

function encodeLengthPrefix(length: number): Buffer {
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32BE(length, 0);
  return encoded;
}

function decodeLengthPrefix(payload: Buffer, offset: number): number {
  if (offset + 4 > payload.length) {
    throw new Error('Invalid session handoff transfer payload');
  }
  return payload.readUInt32BE(offset);
}

async function writeFileHandleBufferFully(params: Readonly<{
  file: Awaited<ReturnType<typeof open>>;
  buffer: Buffer;
  position?: number;
}>): Promise<number> {
  let totalBytesWritten = 0;

  while (totalBytesWritten < params.buffer.byteLength) {
    const { bytesWritten } = await params.file.write(
      params.buffer,
      totalBytesWritten,
      params.buffer.byteLength - totalBytesWritten,
      typeof params.position === 'number' ? params.position + totalBytesWritten : undefined,
    );
    if (bytesWritten === 0) {
      throw new Error('Invalid session handoff transfer payload');
    }
    totalBytesWritten += bytesWritten;
  }

  return totalBytesWritten;
}

function resolveSessionHandoffMetadataV2FromPayloadSourceOptions(
  options?: SessionHandoffTransferredBundlesPayloadSourceOptions,
): SessionHandoffMetadataV2 | undefined {
  return options?.handoffMetadataV2;
}

function createSessionHandoffTransferredBundlesBinaryHeader(
  payload: SessionHandoffTransferredBundles,
  options?: SessionHandoffTransferredBundlesPayloadSourceOptions,
): SessionHandoffTransferredBundlesBinaryHeader {
  const normalized = createSessionHandoffTransferredBundles(payload);
  const explicitBlobProvider = options?.blobProvider;
  const handoffMetadataV2 = resolveSessionHandoffMetadataV2FromPayloadSourceOptions(options);
  const includeWorkspaceBlobPayloads =
    options?.includeWorkspaceBlobPayloads
    ?? !handoffMetadataV2?.workspaceReplicationMetadata;
  const workspaceArtifacts = normalized.workspaceExportArtifacts
    ? {
      manifest: cloneScmSourceControllerWorkspaceExportManifest(normalized.workspaceExportArtifacts.manifest),
      blobs: includeWorkspaceBlobPayloads
        ? explicitBlobProvider
          ? normalized.workspaceExportArtifacts.manifest.entries.flatMap((entry) =>
            entry.kind === 'file'
              ? [{
                digest: entry.digest,
                sizeBytes: entry.sizeBytes,
              }]
              : [],
          ).filter((blob, index, allBlobs) =>
            allBlobs.findIndex((candidate) => candidate.digest === blob.digest) === index,
          )
          : [...normalized.workspaceExportArtifacts.blobContentsByDigest.entries()].map(([digest, content]) => ({
            digest,
            sizeBytes: content.byteLength,
          }))
        : [],
      ...(normalized.workspaceExportArtifacts.sourceControllerMetadata
        ? { sourceControllerMetadata: normalized.workspaceExportArtifacts.sourceControllerMetadata }
        : {}),
    }
    : undefined;

  return {
    ...(handoffMetadataV2
      ? { handoffMetadataV2 }
      : {}),
    ...(workspaceArtifacts ? { workspaceArtifacts } : {}),
  };
}

function createSessionHandoffTransferredBundlesBinaryPayloadParts(
  payload: SessionHandoffTransferredBundles,
  options?: SessionHandoffTransferredBundlesPayloadSourceOptions,
): readonly Buffer[] {
  const normalized = createSessionHandoffTransferredBundles(payload);
  const header = createSessionHandoffTransferredBundlesBinaryHeader(normalized, options);
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
  const workspaceBlobBuffers = normalized.workspaceExportArtifacts
    ? [...normalized.workspaceExportArtifacts.blobContentsByDigest.values()].map((content) => Buffer.from(content))
    : [];

  return [
    SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC,
    encodeLengthPrefix(headerBuffer.length),
    headerBuffer,
    ...workspaceBlobBuffers.flatMap((content) => [encodeLengthPrefix(content.byteLength), content]),
  ];
}

function encodeSessionHandoffTransferredBundlesBinaryPayload(
  payload: SessionHandoffTransferredBundles,
): Buffer {
  return Buffer.concat([...createSessionHandoffTransferredBundlesBinaryPayloadParts(payload)]);
}

export async function createSessionHandoffTransferredBundlesPayloadSource(
  payload: SessionHandoffTransferredBundles,
  options?: SessionHandoffTransferredBundlesPayloadSourceOptions,
): Promise<TransferPayloadSource> {
  const normalized = createSessionHandoffTransferredBundles(payload);
  const header = createSessionHandoffTransferredBundlesBinaryHeader(normalized, options);
  const tempDir = join(tmpdir(), 'happier-session-handoff-transfers');
  await mkdir(tempDir, { recursive: true });
  const filePath = join(tempDir, `handoff-${randomUUID()}.bin`);
  const file = await open(filePath, 'w');
  const hash = createHash('sha256');
  let sizeBytes = 0;

  try {
    const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
    for (const part of [
      SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC,
      encodeLengthPrefix(headerBuffer.length),
      headerBuffer,
    ]) {
      await writeFileHandleBufferFully({
        file,
        buffer: part,
      });
      hash.update(part);
      sizeBytes += part.byteLength;
    }

    for (const blob of header.workspaceArtifacts?.blobs ?? []) {
      const blobLengthPrefix = encodeLengthPrefix(blob.sizeBytes);
      await writeFileHandleBufferFully({
        file,
        buffer: blobLengthPrefix,
      });
      hash.update(blobLengthPrefix);
      sizeBytes += blobLengthPrefix.byteLength;

      const inlineBlobContent = normalized.workspaceExportArtifacts?.blobContentsByDigest.get(blob.digest);
      if (inlineBlobContent) {
        const blobBuffer = Buffer.from(inlineBlobContent);
        if (blobBuffer.byteLength !== blob.sizeBytes) {
          throw new Error('Invalid session handoff transfer payload');
        }
        await writeFileHandleBufferFully({
          file,
          buffer: blobBuffer,
        });
        hash.update(blobBuffer);
        sizeBytes += blobBuffer.byteLength;
        continue;
      }

      const blobPath = options?.blobProvider?.getBlobFilePath(blob.digest);
      if (!blobPath) {
        throw new Error(`Missing workspace blob for digest ${blob.digest}`);
      }

      const blobFile = await open(blobPath, 'r');
      try {
        let bytesReadTotal = 0;
        while (bytesReadTotal < blob.sizeBytes) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, blob.sizeBytes - bytesReadTotal));
          const { bytesRead } = await blobFile.read(chunk, 0, chunk.byteLength, bytesReadTotal);
          if (bytesRead === 0) {
            throw new Error('Invalid session handoff transfer payload');
          }
          const chunkBuffer = chunk.subarray(0, bytesRead);
          await writeFileHandleBufferFully({
            file,
            buffer: chunkBuffer,
          });
          hash.update(chunkBuffer);
          sizeBytes += chunkBuffer.byteLength;
          bytesReadTotal += bytesRead;
        }
      } finally {
        await blobFile.close();
      }
    }
  } catch (error) {
    await file.close();
    await rm(filePath, { force: true });
    throw error;
  }

  await file.close();

  return createFileTransferPayloadSource({
    filePath,
    sizeBytes,
    manifestHash: `sha256:${hash.digest('hex')}`,
    dispose: async () => {
      await rm(filePath, { force: true });
    },
  });
}

function parseBinarySourceControllerMetadata(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session handoff transfer payload');
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseBinaryDirectPeerPublication(value: unknown): SessionHandoffWorkspaceReplicationDirectPeerPublication | null {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session handoff transfer payload');
  }
  const blobPacks = (value as { blobPacks?: unknown }).blobPacks;
  if (!Array.isArray(blobPacks)) {
    throw new Error('Invalid session handoff transfer payload');
  }

  return {
    blobPacks: blobPacks.map((blobPack) => {
      if (!blobPack || typeof blobPack !== 'object' || Array.isArray(blobPack)) {
        throw new Error('Invalid session handoff transfer payload');
      }
      const parsedEndpointCandidates = Array.isArray((blobPack as { endpointCandidates?: unknown }).endpointCandidates)
        ? (blobPack as { endpointCandidates: unknown[] }).endpointCandidates.map((endpointCandidate) => {
          const parsed = TransferEndpointCandidateSchema.safeParse(endpointCandidate);
          if (!parsed.success) {
            throw new Error('Invalid session handoff transfer payload');
          }
          return parsed.data;
        })
        : null;
      const transferId = (blobPack as { transferId?: unknown }).transferId;
      const packId = (blobPack as { packId?: unknown }).packId;
      const digests = (blobPack as { digests?: unknown }).digests;
      if (
        typeof transferId !== 'string'
        || transferId.length === 0
        || typeof packId !== 'string'
        || packId.length === 0
        || !Array.isArray(digests)
        || digests.length !== 1
        || typeof digests[0] !== 'string'
        || digests[0].length === 0
        || !parsedEndpointCandidates
      ) {
        throw new Error('Invalid session handoff transfer payload');
      }
      return {
        transferId,
        packId,
        digests: [digests[0]],
        endpointCandidates: parsedEndpointCandidates,
      };
    }),
  };
}

function resolveLegacySessionHandoffMetadataV2(input: Readonly<{
  parsedHeader: SessionHandoffTransferredBundlesBinaryHeader;
  sourceControllerMetadata?: Readonly<Record<string, unknown>>;
  manifest?: ScmSourceControllerWorkspaceExportArtifacts['manifest'];
}>): SessionHandoffMetadataV2 | undefined {
  const providerBundleTransferPublication =
    input.parsedHeader.handoffMetadataV2?.providerBundleTransferPublication;
  const workspaceReplicationMetadata =
    input.parsedHeader.handoffMetadataV2?.workspaceReplicationMetadata
    ?? (input.parsedHeader.workspaceReplicationSourceRootPath && input.manifest
      ? {
          sourceRootPath: input.parsedHeader.workspaceReplicationSourceRootPath,
          manifest: input.manifest,
          ...(input.sourceControllerMetadata ? { sourceControllerMetadata: input.sourceControllerMetadata } : {}),
        } satisfies SessionHandoffWorkspaceReplicationMetadata
      : undefined);
  const workspaceReplicationDirectPeerPublication =
    input.parsedHeader.handoffMetadataV2?.workspaceReplicationDirectPeerPublication
    ?? parseBinaryDirectPeerPublication(input.parsedHeader.workspaceReplicationDirectPeerPublication) ?? undefined;

  return createSessionHandoffMetadataV2({
    ...(providerBundleTransferPublication ? { providerBundleTransferPublication } : {}),
    ...(workspaceReplicationMetadata ? { workspaceReplicationMetadata } : {}),
    ...(workspaceReplicationDirectPeerPublication ? { workspaceReplicationDirectPeerPublication } : {}),
  });
}

async function readFileHandleBuffer(params: Readonly<{
  file: Awaited<ReturnType<typeof open>>;
  position: number;
  length: number;
}>): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(params.length);
  let totalBytesRead = 0;

  while (totalBytesRead < params.length) {
    const { bytesRead } = await params.file.read(
      buffer,
      totalBytesRead,
      params.length - totalBytesRead,
      params.position + totalBytesRead,
    );
    if (bytesRead === 0) {
      throw new Error('Invalid session handoff transfer payload');
    }
    totalBytesRead += bytesRead;
  }

  return buffer;
}

async function commitBlobRangeToCas(params: Readonly<{
  file: Awaited<ReturnType<typeof open>>;
  activeServerDir: string;
  digest: string;
  startOffset: number;
  sizeBytes: number;
}>): Promise<void> {
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: params.activeServerDir,
  });
  const tempDir = join(tmpdir(), 'happier-session-handoff-transfers-received');
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `handoff-blob-${randomUUID()}.bin`);
  const tempFile = await open(tempPath, 'w');
  let writtenBytes = 0;

  try {
    while (writtenBytes < params.sizeBytes) {
      const nextChunkSize = Math.min(64 * 1024, params.sizeBytes - writtenBytes);
      const chunk = await readFileHandleBuffer({
        file: params.file,
        position: params.startOffset + writtenBytes,
        length: nextChunkSize,
      });
      await writeFileHandleBufferFully({
        file: tempFile,
        buffer: chunk,
        position: writtenBytes,
      });
      writtenBytes += chunk.length;
    }
  } catch (error) {
    await tempFile.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  await tempFile.close();

  try {
    await casStore.commitFile({
      digest: params.digest,
      sourcePath: tempPath,
    });
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function decodeSessionHandoffTransferredBundlesBinaryPayload(
  payload: Buffer,
): SessionHandoffTransferredBundles {
  if (
    payload.length < SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC.length + 4
    || !payload.subarray(0, SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC.length)
      .equals(SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC)
  ) {
    throw new Error('Invalid session handoff transfer payload');
  }

  let offset = SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC.length;
  const headerLength = decodeLengthPrefix(payload, offset);
  offset += 4;
  if (offset + headerLength > payload.length) {
    throw new Error('Invalid session handoff transfer payload');
  }

  const parsedHeader = JSON.parse(payload.subarray(offset, offset + headerLength).toString('utf8')) as
    SessionHandoffTransferredBundlesBinaryHeader;
  offset += headerLength;

  const workspaceArtifactsHeader = parsedHeader.workspaceArtifacts;
  if (!workspaceArtifactsHeader) {
    if (offset !== payload.length) {
      throw new Error('Invalid session handoff transfer payload');
    }
    return createSessionHandoffTransferredBundles({});
  }

  const parsedManifest = WorkspaceManifestSchema.safeParse(workspaceArtifactsHeader.manifest);
  if (!parsedManifest.success) {
    throw new Error('Invalid session handoff transfer payload');
  }
  if (!Array.isArray(workspaceArtifactsHeader.blobs)) {
    throw new Error('Invalid session handoff transfer payload');
  }

  const blobContentsByDigest = new Map<string, Buffer>();
  for (const blob of workspaceArtifactsHeader.blobs) {
    if (
      !blob
      || typeof blob !== 'object'
      || Array.isArray(blob)
      || typeof blob.digest !== 'string'
      || blob.digest.length === 0
      || typeof blob.sizeBytes !== 'number'
      || !Number.isInteger(blob.sizeBytes)
      || blob.sizeBytes < 0
    ) {
      throw new Error('Invalid session handoff transfer payload');
    }
    const blobLength = decodeLengthPrefix(payload, offset);
    offset += 4;
    if (blobLength !== blob.sizeBytes || offset + blobLength > payload.length) {
      throw new Error('Invalid session handoff transfer payload');
    }
    blobContentsByDigest.set(blob.digest, Buffer.from(payload.subarray(offset, offset + blobLength)));
    offset += blobLength;
  }

  if (offset !== payload.length) {
    throw new Error('Invalid session handoff transfer payload');
  }

  return createSessionHandoffTransferredBundles({
    workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
      manifest: parsedManifest.data,
      blobContentsByDigest,
      sourceControllerMetadata: parseBinarySourceControllerMetadata(workspaceArtifactsHeader.sourceControllerMetadata),
    }),
  });
}

export async function receiveSessionHandoffTransferredBundlesPayloadFile(input: Readonly<{
  activeServerDir: string;
  payloadFilePath: string;
}>): Promise<ReceivedSessionHandoffTransferredBundlesPayloadFile> {
  const payloadFile = await open(input.payloadFilePath, 'r');

  try {
    const { size: payloadSize } = await payloadFile.stat();
    if (payloadSize < SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC.length + 4) {
      const payload = await readFileHandleBuffer({
        file: payloadFile,
        position: 0,
        length: payloadSize,
      });
      const compatibilityPayload = parseSessionHandoffTransferredCompatibilityPayloadBuffer(payload);
      const projected = await projectSeparatedProviderBundlePayloadSource(compatibilityPayload);
      return {
        transferredBundles: projected.transferredBundles,
        ...(projected.providerBundlePayloadSource
          ? { providerBundlePayloadSource: projected.providerBundlePayloadSource }
          : {}),
      };
    }

    const magic = await readFileHandleBuffer({
      file: payloadFile,
      position: 0,
      length: SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC.length,
    });
    if (!magic.equals(SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC)) {
      const payload = await readFileHandleBuffer({
        file: payloadFile,
        position: 0,
        length: payloadSize,
      });
      const compatibilityPayload = parseSessionHandoffTransferredCompatibilityPayloadBuffer(payload);
      const projected = await projectSeparatedProviderBundlePayloadSource(compatibilityPayload);
      return {
        transferredBundles: projected.transferredBundles,
        ...(projected.providerBundlePayloadSource
          ? { providerBundlePayloadSource: projected.providerBundlePayloadSource }
          : {}),
      };
    }

    let offset = SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC.length;
    const headerLengthBuffer = await readFileHandleBuffer({
      file: payloadFile,
      position: offset,
      length: 4,
    });
    const headerLength = decodeLengthPrefix(headerLengthBuffer, 0);
    offset += 4;
    if (offset + headerLength > payloadSize) {
      throw new Error('Invalid session handoff transfer payload');
    }

    const headerBuffer = await readFileHandleBuffer({
      file: payloadFile,
      position: offset,
      length: headerLength,
    });
    const parsedHeader = JSON.parse(headerBuffer.toString('utf8')) as SessionHandoffTransferredBundlesBinaryHeader;
    offset += headerLength;

    const providerBundle = parsedHeader.providerBundle === undefined
      ? undefined
      : SessionHandoffProviderBundleSchema.parse(parsedHeader.providerBundle);
    const workspaceArtifactsHeader = parsedHeader.workspaceArtifacts;
    if (!workspaceArtifactsHeader) {
      const handoffMetadataV2 = parseSessionHandoffMetadataV2(parsedHeader.handoffMetadataV2);
      if (offset !== payloadSize) {
        throw new Error('Invalid session handoff transfer payload');
      }
      const providerBundlePayloadSource = providerBundle
        ? await createSessionHandoffProviderBundlePayloadSource(providerBundle)
        : undefined;
      return {
        ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
        ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
        transferredBundles: createSessionHandoffTransferredBundles({}),
      };
    }

    const parsedManifest = WorkspaceManifestSchema.safeParse(workspaceArtifactsHeader.manifest);
    if (!parsedManifest.success || !Array.isArray(workspaceArtifactsHeader.blobs)) {
      throw new Error('Invalid session handoff transfer payload');
    }
    const sourceControllerMetadata =
      parseBinarySourceControllerMetadata(workspaceArtifactsHeader.sourceControllerMetadata) ?? undefined;
    const handoffMetadataV2 =
      parseSessionHandoffMetadataV2(parsedHeader.handoffMetadataV2)
      ?? resolveLegacySessionHandoffMetadataV2({
        parsedHeader,
        manifest: parsedManifest.data,
        ...(sourceControllerMetadata ? { sourceControllerMetadata } : {}),
      });

    const casStore = createWorkspaceReplicationCasStore({
      activeServerDir: input.activeServerDir,
    });
    for (const blob of workspaceArtifactsHeader.blobs) {
      if (
        !blob
        || typeof blob !== 'object'
        || Array.isArray(blob)
        || typeof blob.digest !== 'string'
        || blob.digest.length === 0
        || typeof blob.sizeBytes !== 'number'
        || !Number.isInteger(blob.sizeBytes)
        || blob.sizeBytes < 0
      ) {
        throw new Error('Invalid session handoff transfer payload');
      }
      const blobLengthBuffer = await readFileHandleBuffer({
        file: payloadFile,
        position: offset,
        length: 4,
      });
      const blobLength = decodeLengthPrefix(blobLengthBuffer, 0);
      offset += 4;
      if (blobLength !== blob.sizeBytes || offset + blobLength > payloadSize) {
        throw new Error('Invalid session handoff transfer payload');
      }
      await commitBlobRangeToCas({
        file: payloadFile,
        activeServerDir: input.activeServerDir,
        digest: blob.digest,
        startOffset: offset,
        sizeBytes: blobLength,
      });
      offset += blobLength;
    }

    if (offset !== payloadSize) {
      throw new Error('Invalid session handoff transfer payload');
    }
    const providerBundlePayloadSource = providerBundle
      ? await createSessionHandoffProviderBundlePayloadSource(providerBundle)
      : undefined;

    return {
      ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
      ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
      transferredBundles: createCanonicalWorkspaceOnlyTransferredBundles(
        createScmSourceControllerWorkspaceExportArtifacts({
          manifest: parsedManifest.data,
          blobContentsByDigest: new Map(),
          sourceControllerMetadata,
        }),
      ),
      ...(workspaceArtifactsHeader.blobs.length > 0
        ? {
          blobProvider: {
            getBlobFilePath: (digest) => casStore.resolveBlobPath(digest),
          } satisfies WorkspaceExportBlobProvider,
        }
        : {}),
    };
  } finally {
    await payloadFile.close();
  }
}

export function createSessionHandoffTransferredBundlesCodec(input?: Readonly<{
  mapDecodeError?: (params: Readonly<{ transferId: string; error: unknown }>) => Error;
}>): TransferPayloadCodec<SessionHandoffTransferredBundles> {
  return {
    encode: (payload) => encodeSessionHandoffTransferredBundlesBinaryPayload(payload),
    decode: ({ transferId, payload }) => {
      try {
        return decodeSessionHandoffTransferredBundlesBinaryPayload(payload);
      } catch (error) {
        if (input?.mapDecodeError) {
          throw input.mapDecodeError({ transferId, error });
        }
        throw new Error('Invalid session handoff transfer payload');
      }
    },
  };
}

export const sessionHandoffTransferredBundlesCodec = createSessionHandoffTransferredBundlesCodec();
