import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/mini';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createWorkspaceEntryExportSource } from '@/machines/transfer/prepareWorkspaceFileExport';
import { createPreparedFilesystemEntryCopyDestination } from '@/machines/transfer/preparedFilesystemEntryCopyDestination';
import type { DirectTransferImportOpenRequest, DirectTransferImportSessionManager } from '@/machines/transfer/directTransferImportSession';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { invalidOperation, type FilesystemEffectConfiguration } from './filesystemEffectOperation';
import { authorizeFilesystemPathWithinRoot } from './accessPolicy/filesystemPathAuthorization';

const text = z.string().check(z.minLength(1));
const destinationSchema = z.strictObject({ operationId: text, rootPath: text, path: text,
  overwrite: z.boolean(), recursive: z.boolean(), expectation: WorkspaceSyncEntryExpectationV1Schema });
type Destination = z.infer<typeof destinationSchema>;
type PayloadDescriptor = Readonly<{ sourceId: string; name: string; sizeBytes: number; manifestHash: string }>;
type Stage = { directory: string; input: Destination; payloads: Map<string, { path: string; finalized: boolean }>; retained: boolean };

/** The existing entry source/apply owners run in this same selected native
 * process. Stage IDs refer only to its existing temporary custody directories;
 * neither an imported pathname nor an accepted WorkspaceRef grants access. */
export function createFilesystemEffectEntryOwner(configuration: FilesystemEffectConfiguration,
  uploads: DirectTransferImportSessionManager,
  registerSource: (source: TransferPayloadSource, name: string) => Promise<PayloadDescriptor>, signal?: AbortSignal) {
  const exports = new Map<string, Awaited<ReturnType<typeof createWorkspaceEntryExportSource>>>();
  const stages = new Map<string, Stage>();
  const assertCurrentAuthority = async () => { signal?.throwIfAborted(); };
  return {
    async openExport(raw: unknown) {
      const request = z.strictObject({ rootPath: text, path: text, operationId: text }).parse(raw);
      const admitted = authorizeFilesystemPathWithinRoot({ targetPath: request.path, rootPath: request.rootPath,
        defaultDirectory: configuration.workingDirectory, accessPolicy: configuration.accessPolicy,
        additionalAllowedDirs: configuration.additionalAllowedReadDirs });
      if (!admitted.valid) throw Object.assign(new Error(admitted.error), { code: admitted.errorCode });
      const exported = await createWorkspaceEntryExportSource({ ...request, rootPath: admitted.rootPath, path: admitted.resolvedPath, accessPolicy: configuration.accessPolicy,
        additionalAllowedReadDirs: configuration.additionalAllowedReadDirs, assertCurrentAuthority });
      const descriptor = await registerSource(exported.payloadSource, exported.name);
      exports.set(descriptor.sourceId, exported);
      return { ...descriptor, entryTree: exported.entryTree };
    },
    async resolveExport(sourceId: string, transferId: string) {
      const exported = exports.get(sourceId);
      if (!exported?.onDemandScope.allowTransferId(transferId)) throw invalidOperation();
      return await registerSource(await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: null }), transferId);
    },
    async prepare(raw: unknown) {
      const input = destinationSchema.parse(raw);
      const directory = createHappierTempDir({ purpose: 'filesystem-copy-destination' });
      const stageId = randomUUID();
      stages.set(stageId, { directory, input, payloads: new Map(), retained: false });
      return { stageId };
    },
    async openUpload(stageId: string, input: DirectTransferImportOpenRequest) {
      const stage = stages.get(stageId);
      if (!stage || input.t !== 'session_file_upload_v1') throw invalidOperation();
      const path = join(stage.directory, `payload-${stage.payloads.size}`);
      const opened = await uploads.openTrustedImportSession({ ...input, workingDirectory: stage.directory, path,
        additionalAllowedWriteDirs: [] }, undefined, stage.directory);
      if (opened.success) stage.payloads.set(opened.response.uploadId, { path, finalized: false });
      return opened;
    },
    async finalizeUpload(stageId: string, uploadId: string) {
      const payload = stages.get(stageId)?.payloads.get(uploadId);
      if (!payload) throw invalidOperation();
      const result = await uploads.finalizeImportTransferSession({ uploadId });
      if (result.success) payload.finalized = true;
      return result;
    },
    async apply(stageId: string, raw: unknown) {
      const stage = stages.get(stageId);
      if (!stage) throw invalidOperation();
      const payloads = z.array(z.strictObject({ transferId: text, uploadId: text })).parse(raw);
      const byTransfer = new Map(payloads.map(payload => [payload.transferId, payload.uploadId]));
      if (byTransfer.size !== payloads.length) throw invalidOperation();
      await mkdir(join(stage.directory, 'recovery'));
      const outcome = await createPreparedFilesystemEntryCopyDestination({ workingDirectory: configuration.workingDirectory,
        accessPolicy: configuration.accessPolicy,
        getAdditionalAllowedReadDirs: () => configuration.additionalAllowedReadDirs ?? [],
        getAdditionalAllowedWriteDirs: () => configuration.additionalAllowedWriteDirs ?? [],
      })({ ...stage.input, stagingDirectory: join(stage.directory, 'stage'), recoveryDirectory: join(stage.directory, 'recovery'),
        assertCurrentAuthority, signal, requestPayload: async request => {
          const uploadId = byTransfer.get(request.transferId);
          const payload = uploadId ? stage.payloads.get(uploadId) : undefined;
          if (!payload?.finalized) throw invalidOperation();
          await copyFile(payload.path, request.destinationPath);
        } });
      if (outcome.status === 'recovery_needed') stage.retained = true;
      return outcome;
    },
    async close(stageId: string, retain = false) {
      const stage = stages.get(stageId);
      if (!stage) return { success: true };
      stage.retained ||= retain;
      for (const uploadId of stage.payloads.keys()) await uploads.abortImportTransferSession({ uploadId });
      if (!stage.retained) await removeHappierTempDirAsync(stage.directory);
      stages.delete(stageId);
      return { success: true };
    },
    async dispose() {
      for (const stage of stages.values()) if (!stage.retained) await removeHappierTempDirAsync(stage.directory);
      stages.clear();
      exports.clear();
    },
  };
}
