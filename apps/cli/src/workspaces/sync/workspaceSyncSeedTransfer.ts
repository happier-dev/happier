import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManifestSchema } from '@happier-dev/protocol/workspaces/manifestSchema';
import type { WorkspaceContentPolicyV1 } from '@happier-dev/protocol';
import type { ScmBackendRegistry } from '@/scm/registry';
import { buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration } from '@/scm/workspace/workspaceTransferResolution';
import type { ScmWorkspaceIntegrationWorkspaceExportArtifacts } from '@/scm/workspace/workspaceExportArtifacts';
import type { ScmWorkspaceIntegrationWorkspaceTransferRequestInput } from '@/scm/workspace/workspaceTransfer';
import type { WorkspaceExportBlobProvider } from '@/scm/workspace/workspaceExportStaging/stageWorkspaceEntries';
import type {
  WorkspaceExportMaterializationCustody,
  WorkspaceTargetMaterializationFence,
} from '@/scm/workspace/workspaceExportMaterialization';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import {
  createBufferTransferPayloadSource,
  createFileTransferPayloadSource,
  type TransferPayloadSource,
} from '@/machines/transfer/transferPayloadSource';

type WorkspaceSyncSeedEnvelopeV1 = Readonly<{
  v: 1;
  workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
  blobTransferIds: Readonly<Record<string, string>>;
}>;

const WORKSPACE_SYNC_SEED_MATERIALIZATION_NAMING = {
  siblingCopySuffixBase: 'happier-sync-seed',
  backupDirectoryPrefix: '.happier-sync-backup',
  stagingIdPrefix: 'workspace-sync-seed',
} as const;

/** One content-policy projection for enrolled copy_once and managed Session seeds. */
export function resolveWorkspaceSyncSeedTransfer(
  contentPolicy: Pick<WorkspaceContentPolicyV1, 'selection' | 'extraIncludePatterns' | 'extraIgnorePatterns'>,
): ScmWorkspaceIntegrationWorkspaceTransferRequestInput {
  const ignoredIncludeGlobs = [...contentPolicy.extraIncludePatterns];
  return {
    includeIgnoredMode: ignoredIncludeGlobs.length > 0 ? 'include_selected' as const : 'exclude' as const,
    ignoredIncludeGlobs,
    ...(contentPolicy.selection === 'all_files' ? { includeAllIgnored: true } : {}),
    extraIgnorePatterns: [...contentPolicy.extraIgnorePatterns],
  };
}

function blobTransferId(operationId: string, digest: string): string {
  return `${operationId}:blob:${createHash('sha256').update(digest).digest('hex')}`;
}

export async function createWorkspaceSyncSeedExport(input: Readonly<{
  operationId: string;
  activeServerDir: string;
  sourcePath: string;
  workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
  registry?: ScmBackendRegistry;
}>): Promise<Readonly<{
  payloadSource: TransferPayloadSource;
  onDemandScope: DirectPeerOnDemandTransferScope;
  blobTransferIds: readonly string[];
}>> {
  const built = await buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration(input);
  const digests = [...new Set(built.workspaceExportArtifacts.manifest.entries.flatMap((entry) => (
    entry.kind === 'file' ? [entry.digest] : []
  )))];
  const transferIdByDigest = new Map(digests.map((digest) => [digest, blobTransferId(input.operationId, digest)]));
  const digestByTransferId = new Map([...transferIdByDigest].map(([digest, transferId]) => [transferId, digest]));
  const envelope: WorkspaceSyncSeedEnvelopeV1 = {
    v: 1,
    workspaceExportArtifacts: built.workspaceExportArtifacts,
    blobTransferIds: Object.fromEntries(transferIdByDigest),
  };
  return {
    blobTransferIds: [...digestByTransferId.keys()],
    payloadSource: createBufferTransferPayloadSource(Buffer.from(JSON.stringify(envelope), 'utf8')),
    onDemandScope: {
      allowTransferId: (transferId) => digestByTransferId.has(transferId),
      maxResolvedTransfers: digests.length,
      resolvePayloadSourceOnOpen: async ({ transferId }) => {
        const digest = digestByTransferId.get(transferId);
        const filePath = digest ? built.blobProvider?.getBlobFilePath(digest) : null;
        if (!digest || !filePath) throw new Error('Workspace sync seed blob is not authorized');
        return createFileTransferPayloadSource({
          filePath,
          ...(built.blobProvider?.disposeBlobFilePath
            ? { dispose: async () => await built.blobProvider?.disposeBlobFilePath?.(digest) }
            : {}),
        });
      },
    },
  };
}

export async function materializeLocalWorkspaceSyncSeed(input: Readonly<{
  operationId: string;
  activeServerDir: string;
  sourcePath: string;
  targetPath: string;
  workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
  materializationReceiptPath?: string;
  originalTargetExists?: boolean;
  targetFence?: WorkspaceTargetMaterializationFence;
  registry?: ScmBackendRegistry;
}>): Promise<WorkspaceExportMaterializationCustody> {
  const built = await buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration(input);
  try {
    const materialized = await materializeWorkspaceExportArtifactsWithScmWorkspace({
      workspaceExportArtifacts: built.workspaceExportArtifacts,
      targetPath: input.targetPath,
      conflictPolicy: 'replace_existing',
      blobProvider: built.blobProvider ?? { getBlobFilePath: () => undefined },
      naming: WORKSPACE_SYNC_SEED_MATERIALIZATION_NAMING,
      ...(input.registry ? { registry: input.registry } : {}),
      sourcePath: input.sourcePath,
      ...(input.materializationReceiptPath ? { materializationReceiptPath: input.materializationReceiptPath } : {}),
      ...(input.originalTargetExists === undefined ? {} : { originalTargetExists: input.originalTargetExists }),
      ...(input.targetFence ? { targetFence: input.targetFence } : {}),
    });
    return materialized.custody;
  } finally {
    await built.blobProvider?.dispose?.();
  }
}

function parseEnvelope(raw: Buffer, operationId: string): WorkspaceSyncSeedEnvelopeV1 {
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')) as unknown; } catch { throw new Error('Workspace sync seed manifest is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace sync seed manifest is malformed');
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !record.workspaceExportArtifacts || typeof record.workspaceExportArtifacts !== 'object'
    || !record.blobTransferIds || typeof record.blobTransferIds !== 'object' || Array.isArray(record.blobTransferIds)) {
    throw new Error('Workspace sync seed manifest is malformed');
  }
  const artifacts = record.workspaceExportArtifacts as Record<string, unknown>;
  const manifest = WorkspaceManifestSchema.parse(artifacts.manifest);
  const metadata = artifacts.workspaceIntegrationMetadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw new Error('Workspace sync seed metadata is malformed');
  }
  const allowedDigests = new Set(manifest.entries.flatMap((entry) => entry.kind === 'file' ? [entry.digest] : []));
  const ids = record.blobTransferIds as Record<string, unknown>;
  if (Object.keys(ids).length !== allowedDigests.size) throw new Error('Workspace sync seed blob index is incomplete');
  const parsedIds: Record<string, string> = {};
  for (const digest of allowedDigests) {
    const transferId = ids[digest];
    if (transferId !== blobTransferId(operationId, digest)) throw new Error('Workspace sync seed blob index is malformed');
    parsedIds[digest] = transferId;
  }
  return {
    v: 1,
    workspaceExportArtifacts: {
      manifest,
      ...(metadata ? { workspaceIntegrationMetadata: metadata as Readonly<Record<string, unknown>> } : {}),
    },
    blobTransferIds: parsedIds,
  };
}

export async function materializeWorkspaceSyncSeedExport(input: Readonly<{
  operationId: string;
  targetPath: string;
  signal?: AbortSignal;
  materializationReceiptPath?: string;
  originalTargetExists?: boolean;
  targetFence?: WorkspaceTargetMaterializationFence;
  requestPayload(request: Readonly<{
    transferId: string;
    destinationPath: string;
    expectedSizeBytes?: number;
    expectedManifestHash?: string;
  }>): Promise<void>;
  materializeWorkspaceExportArtifacts(request: Readonly<{
    workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
    targetPath: string;
    conflictPolicy: 'replace_existing';
    blobProvider: WorkspaceExportBlobProvider;
    naming: Readonly<{ siblingCopySuffixBase: string; backupDirectoryPrefix: string; stagingIdPrefix: string }>;
    materializationReceiptPath?: string;
    originalTargetExists?: boolean;
    targetFence?: WorkspaceTargetMaterializationFence;
    assertCanContinue?: () => Promise<void>;
  }>): Promise<Readonly<{ targetPath: string; custody: WorkspaceExportMaterializationCustody }>>;
}>): Promise<WorkspaceExportMaterializationCustody> {
  input.signal?.throwIfAborted();
  const operationDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-sync-seed-'));
  try {
    const manifestPath = join(operationDirectory, 'manifest.json');
    await input.requestPayload({ transferId: input.operationId, destinationPath: manifestPath });
    input.signal?.throwIfAborted();
    const envelope = parseEnvelope(await readFile(manifestPath), input.operationId);
    const blobPaths = new Map<string, string>();
    const sizeByDigest = new Map(envelope.workspaceExportArtifacts.manifest.entries.flatMap((entry) => (
      entry.kind === 'file' ? [[entry.digest, entry.sizeBytes] as const] : []
    )));
    for (const [digest, transferId] of Object.entries(envelope.blobTransferIds)) {
      const destinationPath = join(operationDirectory, createHash('sha256').update(digest).digest('hex'));
      await input.requestPayload({
        transferId,
        destinationPath,
        expectedSizeBytes: sizeByDigest.get(digest)!,
        expectedManifestHash: digest,
      });
      input.signal?.throwIfAborted();
      blobPaths.set(digest, destinationPath);
    }
    input.signal?.throwIfAborted();
    const materialized = await input.materializeWorkspaceExportArtifacts({
      workspaceExportArtifacts: envelope.workspaceExportArtifacts,
      targetPath: input.targetPath,
      conflictPolicy: 'replace_existing',
      blobProvider: { getBlobFilePath: (digest) => blobPaths.get(digest) },
      naming: WORKSPACE_SYNC_SEED_MATERIALIZATION_NAMING,
      ...(input.materializationReceiptPath ? { materializationReceiptPath: input.materializationReceiptPath } : {}),
      ...(input.originalTargetExists === undefined ? {} : { originalTargetExists: input.originalTargetExists }),
      ...(input.targetFence ? { targetFence: input.targetFence } : {}),
      ...(input.signal
        ? { assertCanContinue: async () => input.signal?.throwIfAborted() }
        : {}),
    });
    return materialized.custody;
  } finally {
    await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
