import type { RpcHandlerContext } from '@/api/rpc/types';
import { WorkspaceSyncTargetRoutingV1Schema, type WorkspaceSyncSeedCarrierV1 } from '@happier-dev/protocol/socketRpc';
import type { WorkspaceSyncSeedExportPrepareV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { FiniteTransferMachineTunnel, WorkspaceSyncMachineTunnelOpen } from './workspaceSyncMachineCarrierStream';

import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { projectActionFailureCauseV1, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { encodeContentValue, decodeContentValue } from '@happier-dev/protocol/crypto/contentByteCodec';
import type { ActionOperationProgressUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import type { PinnedUnixDirectoryAccess } from '@/utils/fs/unixPathAccess';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

import { WorkspaceManifestSchema, WorkspaceManifestRelativePathSchema, type WorkspaceManifest } from '@happier-dev/protocol/workspaces/manifestSchema';
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
import type { WorkspaceMaterializedEntryAccess } from '@/scm/workspace/workspaceExportStaging/promoteStagedWorkspace';
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

/** Emitted at the actual seed effect; the containing Action owns its terminal outcome. */
export const WORKSPACE_SYNC_SEED_COPY_PROGRESS = Object.freeze({
  phase: 'project_files_copy', label: 'Copying project files',
} satisfies ActionOperationProgressUpdate);

/** Retain exact copied identities in the existing owning record without expanding every metadata update. */
export function encodeWorkspaceSyncSeedBaseline(manifest: WorkspaceManifest): string {
  return encodeBase64(encodeContentValue(manifest, gzipSync));
}

export function decodeWorkspaceSyncSeedBaseline(encoded: string): WorkspaceManifest {
  const decoded = decodeContentValue(decodeBase64(encoded), gunzipSync);
  if (decoded.status === 'authenticated') {
    const manifest = WorkspaceManifestSchema.safeParse(decoded.value);
    if (manifest.success) return manifest.data;
  }
  throw Object.assign(new Error('The original copied project baseline is unavailable'), { code: 'baseline_unavailable' });
}

const WORKSPACE_SYNC_SEED_MATERIALIZATION_NAMING = {
  siblingCopySuffixBase: 'happier-sync-seed',
  backupDirectoryPrefix: '.happier-sync-backup',
  stagingIdPrefix: 'workspace-sync-seed',
} as const;

/** One content-policy projection for enrolled copy_once and managed Session seeds. */
export function resolveWorkspaceSyncSeedTransfer(
  contentPolicy: Pick<WorkspaceContentPolicyV1, 'selection' | 'extraIncludePatterns' | 'extraIgnorePatterns' | 'contentOnly'>,
  exclusionCandidates?: readonly string[],
): ScmWorkspaceIntegrationWorkspaceTransferRequestInput {
  const ignoredIncludeGlobs = [...contentPolicy.extraIncludePatterns];
  return {
    includeIgnoredMode: ignoredIncludeGlobs.length > 0 ? 'include_selected' as const : 'exclude' as const,
    ignoredIncludeGlobs,
    ...(exclusionCandidates ? { exclusionCandidates } : {}),
    ...(contentPolicy.selection === 'all_files' ? { includeAllIgnored: true } : {}),
    extraIgnorePatterns: [...contentPolicy.extraIgnorePatterns],
    ...(contentPolicy.contentOnly ? { contentOnly: true as const } : {}),
  };
}

/** Preserve SOURCE refusals before either receiver parses the successful seed descriptor. */
export function assertWorkspaceSyncSeedExportSucceeded(response: unknown): void {
  readMachineActionRpcResult(response);
  if (!response || typeof response !== 'object' || !('success' in response) || response.success !== false) return;
  readMachineActionRpcResult({
    error: redactBugReportSensitiveText('error' in response && typeof response.error === 'string'
      ? response.error : 'Workspace source seed export failed'),
    errorCode: readActionErrorCodeV1(response) ?? 'action_failed',
    failureCause: projectActionFailureCauseV1(response, 'workspace.seed.export', { allowUnknownErrorCode: true }),
  });
}

export type CallWorkspaceSyncSeedExport = (descriptor: Readonly<{
  machineId: string;
  request: WorkspaceSyncSeedExportPrepareV1;
  signal?: AbortSignal;
  carrier?: Readonly<{ publicKey: string; onGranted: (carrier: WorkspaceSyncSeedCarrierV1) => void }>;
}>, context: RpcHandlerContext) => Promise<unknown>;

/** Project the admitted writer-target phase for target custody and its reverse seed. */
export function projectWorkspaceSyncWriterTargetContext<C extends RpcHandlerContext | undefined>(
  context: C,
  localMachineId: string,
): C {
  if (!context || context.workspaceSyncTargetRouting || !context.machineAdmission) return context;
  const writerTarget = context.workspaceSyncSourceWriterTargetRouting;
  if (writerTarget?.target.targetMachineId !== localMachineId) return context;
  return { ...context, workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.parse({
    ...writerTarget.target,
    targetContext: { ...writerTarget.source.sourceContext, machineAdmission: context.machineAdmission },
  }) };
}

/** The installed TARGET uses its admitted SOURCE export to open the reverse carrier. */
export async function prepareSignedWorkspaceSyncSeed(input: Readonly<{
  sourceMachineId: string;
  request: WorkspaceSyncSeedExportPrepareV1;
  context: RpcHandlerContext;
  callExport: CallWorkspaceSyncSeedExport;
  openTunnel: WorkspaceSyncMachineTunnelOpen | undefined;
  signal?: AbortSignal;
}>): Promise<Readonly<{ result: unknown; tunnel?: FiniteTransferMachineTunnel }>> {
  const descriptor = { machineId: input.sourceMachineId, request: input.request,
    ...(input.signal ? { signal: input.signal } : {}) };
  const context = projectWorkspaceSyncWriterTargetContext(input.context, input.request.targetMachineId);
  const source = context.workspaceSyncSourceWriterTargetRouting;
  const target = context.workspaceSyncTargetRouting;
  if (input.sourceMachineId === input.request.targetMachineId || !source || !target
    || (source.sourceWriter.machineId === source.source.sourceMachineId
      && source.source.sourceContext.machineAdmission.custodianAccountId === target.targetContext.machineAdmission.custodianAccountId)) {
    return { result: await input.callExport(descriptor, context) };
  }
  if (!input.openTunnel) throw Object.assign(new Error('Workspace seed carrier is unavailable'), { code: 'peer_unavailable' });
  let result: unknown;
  const tunnel = await input.openTunnel({
    flow: 'file_transfer',
    sourceMachineId: input.request.targetMachineId,
    targetMachineId: input.sourceMachineId,
    ...(input.signal ? { signal: input.signal } : {}),
    admittedSeed: { prepare: async publicKey => {
      let grant: WorkspaceSyncSeedCarrierV1 | undefined;
      result = await input.callExport({ ...descriptor, carrier: { publicKey, onGranted: value => { grant = value; } } }, context);
      assertWorkspaceSyncSeedExportSucceeded(result);
      if (!result || typeof result !== 'object' || !('transferId' in result) || result.transferId !== input.request.operationId) {
        throw Object.assign(new Error('Workspace seed export does not match the admitted operation'), { code: 'peer_unavailable' });
      }
      return grant;
    } },
  });
  return { result, tunnel };
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
  payloadSource: ReturnType<typeof createBufferTransferPayloadSource>;
  onDemandScope: Omit<DirectPeerOnDemandTransferScope, 'resolvePayloadSourceOnOpen'> & Readonly<{
    resolvePayloadSourceOnOpen(input: Parameters<DirectPeerOnDemandTransferScope['resolvePayloadSourceOnOpen']>[0]):
      Promise<TransferPayloadSource>;
  }>;
  blobTransferIds: readonly string[];
  excludedPaths?: readonly string[];
}>> {
  const source = currentWorkspaceSource();
  const built = await buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration(input);
  const sizeByDigest = new Map(built.workspaceExportArtifacts.manifest.entries.flatMap(entry =>
    entry.kind === 'file' ? [[entry.digest, entry.sizeBytes] as const] : []));
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
  const bufferSource = createBufferTransferPayloadSource(Buffer.from(JSON.stringify(envelope), 'utf8'));
  return {
    blobTransferIds: [...digestByTransferId.keys()],
    ...(built.workspaceExportArtifacts.excludedPaths ? { excludedPaths: built.workspaceExportArtifacts.excludedPaths } : {}),
    payloadSource: built.blobProvider?.dispose ? { ...bufferSource, dispose: () => built.blobProvider?.dispose?.() } : bufferSource,
    onDemandScope: {
      allowTransferId: (transferId) => digestByTransferId.has(transferId),
      maxResolvedTransfers: digests.length,
      resolvePayloadSourceOnOpen: async ({ transferId }) => {
        const digest = digestByTransferId.get(transferId);
        const filePath = digest ? built.blobProvider?.getBlobFilePath(digest) : null;
        if (!digest || !filePath) throw new Error('Workspace sync seed blob is not authorized');
        if (source.kind === 'target') {
          let opened: ReturnType<typeof source.open> | undefined;
          return {
            kind: 'native', sizeBytes: sizeByDigest.get(digest)!, manifestHash: digest,
            readChunk: async ({ offset, length }) => {
              const file = await (opened ??= source.open(filePath, { noFollow: true }));
              const bytes = Buffer.alloc(length);
              const result = await file.read(bytes, 0, length, offset);
              return bytes.subarray(0, result.bytesRead);
            },
            dispose: async () => {
              try { if (opened) await (await opened).close(); }
              finally { await built.blobProvider?.disposeBlobFilePath?.(digest); }
            },
          };
        }
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

/** Serves a seed its source member built in the member's own process: the daemon holds the
 * envelope and forwards each blob chunk read to that process, so it opens no member path. */
export function createMemberWorkspaceSyncSeedExport(input: Readonly<{
  operationId: string;
  envelope: Uint8Array;
  readBlob(request: Readonly<{ transferId: string; offset: number; length: number }>): Promise<Uint8Array>;
  dispose?: () => Promise<void> | void;
}>): Readonly<{ payloadSource: TransferPayloadSource; onDemandScope: DirectPeerOnDemandTransferScope }> {
  const payload = Buffer.from(input.envelope);
  const envelope = parseEnvelope(payload, input.operationId);
  const sizeByDigest = new Map(envelope.workspaceExportArtifacts.manifest.entries.flatMap((entry) => (
    entry.kind === 'file' ? [[entry.digest, entry.sizeBytes] as const] : [])));
  const digestByTransferId = new Map(Object.entries(envelope.blobTransferIds).map(([digest, transferId]) => [transferId, digest]));
  const bufferSource = createBufferTransferPayloadSource(payload);
  return {
    payloadSource: input.dispose ? { ...bufferSource, dispose: input.dispose } : bufferSource,
    onDemandScope: {
      allowTransferId: (transferId) => digestByTransferId.has(transferId),
      maxResolvedTransfers: digestByTransferId.size,
      resolvePayloadSourceOnOpen: async ({ transferId }) => {
        const digest = digestByTransferId.get(transferId);
        const sizeBytes = digest === undefined ? undefined : sizeByDigest.get(digest);
        if (digest === undefined || sizeBytes === undefined) throw new Error('Workspace sync seed blob is not authorized');
        // A file blob's manifest digest is the sha256 transfer manifest hash of its bytes.
        return { kind: 'native', sizeBytes, manifestHash: digest,
          readChunk: async (range) => Buffer.from(await input.readBlob({ transferId, ...range })) };
      },
    },
  };
}

export async function materializeLocalWorkspaceSyncSeed(input: Readonly<{
  operationId: string;
  activeServerDir: string;
  sourcePath: string;
  targetPath: string;
  prepareEntryAccess?: WorkspaceMaterializedEntryAccess;
  pinnedTargetParent?: PinnedUnixDirectoryAccess;
  workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequestInput;
  materializationReceiptPath?: string;
  originalTargetExists?: boolean;
  targetFence?: WorkspaceTargetMaterializationFence;
  registry?: ScmBackendRegistry;
}>): Promise<WorkspaceExportMaterializationCustody & Readonly<{ manifest: WorkspaceManifest; excludedPaths?: readonly string[] }>> {
  const built = await buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration(input);
  try {
    const materialized = await materializeWorkspaceExportArtifactsWithScmWorkspace({
      workspaceExportArtifacts: built.workspaceExportArtifacts,
      targetPath: input.targetPath,
      prepareEntryAccess: input.prepareEntryAccess,
      pinnedTargetParent: input.pinnedTargetParent,
      conflictPolicy: 'replace_existing',
      blobProvider: built.blobProvider ?? { getBlobFilePath: () => undefined },
      naming: WORKSPACE_SYNC_SEED_MATERIALIZATION_NAMING,
      ...(input.registry ? { registry: input.registry } : {}),
      sourcePath: input.sourcePath,
      ...(input.materializationReceiptPath ? { materializationReceiptPath: input.materializationReceiptPath } : {}),
      ...(input.originalTargetExists === undefined ? {} : { originalTargetExists: input.originalTargetExists }),
      ...(input.targetFence ? { targetFence: input.targetFence } : {}),
    });
    return { ...materialized.custody, get receipt() { return materialized.custody.receipt; },
      manifest: built.workspaceExportArtifacts.manifest,
      ...(built.workspaceExportArtifacts.excludedPaths ? { excludedPaths: built.workspaceExportArtifacts.excludedPaths } : {}) };
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
  const excludedPaths = artifacts.excludedPaths;
  if (excludedPaths !== undefined && !Array.isArray(excludedPaths)) throw new Error('Workspace sync seed exclusions are malformed');
  const parsedExcludedPaths = excludedPaths?.map(path => WorkspaceManifestRelativePathSchema.parse(path));
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
      ...(parsedExcludedPaths ? { excludedPaths: parsedExcludedPaths } : {}),
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
}>): Promise<WorkspaceExportMaterializationCustody & Readonly<{ manifest: WorkspaceManifest; excludedPaths?: readonly string[] }>> {
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
    return { ...materialized.custody, get receipt() { return materialized.custody.receipt; },
      manifest: envelope.workspaceExportArtifacts.manifest,
      ...(envelope.workspaceExportArtifacts.excludedPaths ? { excludedPaths: envelope.workspaceExportArtifacts.excludedPaths } : {}) };
  } finally {
    await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
