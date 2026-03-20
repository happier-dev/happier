import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionHandoffProviderBundleSchema,
  SessionHandoffTransferredPayloadSchema,
  WorkspaceManifestSchema,
  type SessionHandoffProviderBundle as ProtocolSessionHandoffProviderBundle,
  type SessionHandoffTransferredPayload,
} from '@happier-dev/protocol';
import { type TransferPayloadCodec } from '../../../machines/transfer/transferPayloadCodec';
import { createFileTransferPayloadSource, type TransferPayloadSource } from '../../../machines/transfer/transferPayloadSource';
import {
  createScmSourceControllerWorkspaceExportArtifacts,
  createScmSourceControllerWorkspaceExportArtifactsWirePayload,
  cloneScmSourceControllerWorkspaceExportManifest,
  parseScmSourceControllerWorkspaceExportArtifactsWirePayload,
  type ScmSourceControllerWorkspaceExportArtifacts,
} from '@/scm/sourceController/workspaceExportArtifacts';
import type { SessionHandoffProviderBundle } from '../types';
import type { SessionHandoffTransferredArtifact } from './sessionHandoffTransferredArtifacts';

export type SessionHandoffTransferredBundles = Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>;

const SESSION_HANDOFF_TRANSFERRED_BUNDLES_MAGIC = Buffer.from('HHB1', 'utf8');

type SessionHandoffTransferredBundlesBinaryHeader = Readonly<{
  providerBundle: ProtocolSessionHandoffProviderBundle;
  workspaceArtifacts?: Readonly<{
    manifest: ScmSourceControllerWorkspaceExportArtifacts['manifest'];
    blobs: readonly Readonly<{
      digest: string;
      sizeBytes: number;
    }>[];
    sourceControllerMetadata?: Readonly<Record<string, unknown>>;
  }>;
}>;

export function createSessionHandoffTransferredArtifacts(
  payload: SessionHandoffTransferredBundles,
): readonly SessionHandoffTransferredArtifact[] {
  const normalized = createSessionHandoffTransferredBundles(payload);
  return [
    {
      kind: 'provider_bundle',
      providerBundle: normalized.providerBundle,
    },
    ...(normalized.workspaceExportArtifacts
      ? [{
        kind: 'workspace_export_artifacts' as const,
        workspaceExportArtifacts: normalized.workspaceExportArtifacts,
      }]
      : []),
  ];
}

export function createSessionHandoffTransferredBundlesFromArtifacts(
  artifacts: readonly SessionHandoffTransferredArtifact[],
): SessionHandoffTransferredBundles {
  let providerBundle: SessionHandoffProviderBundle | null = null;
  let workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts | null = null;

  for (const artifact of artifacts) {
    if (artifact.kind === 'provider_bundle') {
      providerBundle = artifact.providerBundle;
      continue;
    }
    workspaceExportArtifacts = artifact.workspaceExportArtifacts;
  }

  if (!providerBundle) {
    throw new Error('Invalid session handoff transfer payload');
  }

  return createSessionHandoffTransferredBundles({
    providerBundle,
    ...(workspaceExportArtifacts ? { workspaceExportArtifacts } : {}),
  });
}

export function mergeSessionHandoffTransferredBundles(input: Readonly<{
  current?: SessionHandoffTransferredBundles | null;
  incoming: SessionHandoffTransferredBundles;
}>): SessionHandoffTransferredBundles {
  const mergedByKind = new Map<SessionHandoffTransferredArtifact['kind'], SessionHandoffTransferredArtifact>();

  for (const artifact of [
    ...(input.current ? createSessionHandoffTransferredArtifacts(input.current) : []),
    ...createSessionHandoffTransferredArtifacts(input.incoming),
  ]) {
    if (!mergedByKind.has(artifact.kind)) {
      mergedByKind.set(artifact.kind, artifact);
    }
  }

  return createSessionHandoffTransferredBundlesFromArtifacts(Array.from(mergedByKind.values()));
}

function createTransferredProviderBundleWirePayload(
  providerBundle: SessionHandoffProviderBundle,
): ProtocolSessionHandoffProviderBundle {
  const parsed = SessionHandoffProviderBundleSchema.safeParse(providerBundle);
  if (!parsed.success) {
    throw new Error('Invalid session handoff transfer payload');
  }
  return parsed.data;
}

function hasLegacyTransferredProviderBundleCompatibilityField(
  providerBundle: SessionHandoffProviderBundle,
): boolean {
  if (providerBundle.providerId !== 'codex') {
    return false;
  }
  return 'codexBackendMode' in (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown })
    && (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown }).codexBackendMode !== undefined;
}

function assertCanonicalTransferredBundlesInput(
  payload: SessionHandoffTransferredBundles,
): void {
  if (hasLegacyTransferredProviderBundleCompatibilityField(payload.providerBundle)) {
    throw new Error('Invalid session handoff transfer payload');
  }
}

export function createSessionHandoffTransferredBundles(params: Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>): SessionHandoffTransferredBundles {
  assertCanonicalTransferredBundlesInput(params);
  return {
    providerBundle: params.providerBundle,
    ...(params.workspaceExportArtifacts ? { workspaceExportArtifacts: params.workspaceExportArtifacts } : {}),
  };
}

export function createSessionHandoffTransferredPayload(
  payload: SessionHandoffTransferredBundles,
): SessionHandoffTransferredPayload {
  const normalized = createSessionHandoffTransferredBundles(payload);
  const workspaceArtifacts = normalized.workspaceExportArtifacts
    ? createScmSourceControllerWorkspaceExportArtifactsWirePayload(normalized.workspaceExportArtifacts)
    : null;
  return {
    providerBundle: createTransferredProviderBundleWirePayload(normalized.providerBundle),
    ...(workspaceArtifacts
      ? {
        workspaceArtifacts: {
          ...workspaceArtifacts,
          blobs: workspaceArtifacts.blobs.map((blob) => ({ ...blob })),
        },
      }
      : {}),
  };
}

function decodeCanonicalSessionHandoffTransferredPayload(
  payload: SessionHandoffTransferredPayload,
): SessionHandoffTransferredBundles {
  const workspaceExportArtifacts = payload.workspaceArtifacts === undefined
    ? null
    : parseScmSourceControllerWorkspaceExportArtifactsWirePayload(payload.workspaceArtifacts);
  return createSessionHandoffTransferredBundlesFromArtifacts([
    {
      kind: 'provider_bundle',
      providerBundle: payload.providerBundle,
    },
    ...(workspaceExportArtifacts
      ? [{
        kind: 'workspace_export_artifacts' as const,
        workspaceExportArtifacts,
      }]
      : []),
  ]);
}

function parseSessionHandoffTransferredPayload(payload: unknown): SessionHandoffTransferredBundles {
  const parsed = SessionHandoffTransferredPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid session handoff transfer payload');
  }
  return decodeCanonicalSessionHandoffTransferredPayload(parsed.data);
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

function createSessionHandoffTransferredBundlesBinaryHeader(
  payload: SessionHandoffTransferredBundles,
): SessionHandoffTransferredBundlesBinaryHeader {
  const normalized = createSessionHandoffTransferredBundles(payload);
  const workspaceArtifacts = normalized.workspaceExportArtifacts
    ? {
      manifest: cloneScmSourceControllerWorkspaceExportManifest(normalized.workspaceExportArtifacts.manifest),
      blobs: [...normalized.workspaceExportArtifacts.blobContentsByDigest.entries()].map(([digest, content]) => ({
        digest,
        sizeBytes: content.byteLength,
      })),
      ...(normalized.workspaceExportArtifacts.sourceControllerMetadata
        ? { sourceControllerMetadata: normalized.workspaceExportArtifacts.sourceControllerMetadata }
        : {}),
    }
    : undefined;

  return {
    providerBundle: createTransferredProviderBundleWirePayload(normalized.providerBundle),
    ...(workspaceArtifacts ? { workspaceArtifacts } : {}),
  };
}

function createSessionHandoffTransferredBundlesBinaryPayloadParts(
  payload: SessionHandoffTransferredBundles,
): readonly Buffer[] {
  const normalized = createSessionHandoffTransferredBundles(payload);
  const header = createSessionHandoffTransferredBundlesBinaryHeader(normalized);
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
): Promise<TransferPayloadSource> {
  const tempDir = join(tmpdir(), 'happier-session-handoff-transfers');
  await mkdir(tempDir, { recursive: true });
  const filePath = join(tempDir, `handoff-${randomUUID()}.bin`);
  const file = await open(filePath, 'w');
  const hash = createHash('sha256');
  let sizeBytes = 0;

  try {
    for (const part of createSessionHandoffTransferredBundlesBinaryPayloadParts(payload)) {
      await file.write(part);
      hash.update(part);
      sizeBytes += part.byteLength;
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

  const providerBundle = SessionHandoffProviderBundleSchema.parse(parsedHeader.providerBundle);
  const workspaceArtifactsHeader = parsedHeader.workspaceArtifacts;
  if (!workspaceArtifactsHeader) {
    if (offset !== payload.length) {
      throw new Error('Invalid session handoff transfer payload');
    }
    return createSessionHandoffTransferredBundles({ providerBundle });
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
    providerBundle,
    workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
      manifest: parsedManifest.data,
      blobContentsByDigest,
      sourceControllerMetadata: parseBinarySourceControllerMetadata(workspaceArtifactsHeader.sourceControllerMetadata),
    }),
  });
}

export function normalizeSessionHandoffTransferredBundles(
  payload: SessionHandoffTransferredBundles,
): SessionHandoffTransferredBundles {
  return parseSessionHandoffTransferredPayload(createSessionHandoffTransferredPayload(payload));
}

export function createSessionHandoffTransferredBundlesCodec(input?: Readonly<{
  mapDecodeError?: (params: Readonly<{ transferId: string; error: unknown }>) => Error;
}>): TransferPayloadCodec<SessionHandoffTransferredBundles> {
  return {
    encode: (payload) => encodeSessionHandoffTransferredBundlesBinaryPayload(payload),
    decode: ({ transferId, payload }) => {
      try {
        return decodeSessionHandoffTransferredBundlesBinaryPayload(payload);
      } catch (binaryError) {
        try {
          return parseSessionHandoffTransferredPayload(JSON.parse(payload.toString('utf8')));
        } catch (jsonError) {
          if (input?.mapDecodeError) {
            throw input.mapDecodeError({ transferId, error: jsonError });
          }
          throw new Error('Invalid session handoff transfer payload');
        }
      }
    },
  };
}

export const sessionHandoffTransferredBundlesCodec = createSessionHandoffTransferredBundlesCodec();
