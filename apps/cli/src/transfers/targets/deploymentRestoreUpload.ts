import { z } from 'zod/mini';
import { DeploymentBackupRestoreUploadInitV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import type { TransferSessionStore, UploadTransferTarget } from '@happier-dev/transfers/node';
import { isServerRoutedTransferOverSizeLimit, SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '../policy/serverRoutedTransferPolicy';
import { configuration } from '@/configuration';
import { createFileTransferPayloadSource, readTransferPayloadChunk, type TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

/** This internal process envelope never crosses the public transfer response. */
export const DeploymentRestoreCompletedUploadSchema = z.strictObject({
  uploadId: z.string(), filePath: z.string(), sizeBytes: z.number(), sha256: z.string(), scopeFingerprint: z.string(),
});

/** Host-only source produced by the finite transfer owner after complete-byte admission. */
export type AdmittedDeploymentRestoreUpload = Readonly<{
  kind: 'upload';
  transferId: string;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  readChunk: Extract<TransferPayloadSource, { kind: 'native' }>['readChunk'];
}>;

/** Discriminator routing consumes the public owner; target admission parses the request once. */
export function isDeploymentRestoreUploadKind(kind: unknown): boolean {
  return DeploymentBackupRestoreUploadInitV1Schema.shape.t.safeParse(kind).success;
}

export function deploymentRestoreUploadScope(accountId: string, environmentId: string): string {
  return JSON.stringify([accountId, environmentId]);
}

export function resolveDeploymentRestoreUploadTarget(input: Readonly<{
  request: unknown; accountId: string | undefined; store: TransferSessionStore;
  sessionRpcTransferMaxBytes?: number | null;
}>): Readonly<{ success: true; target: UploadTransferTarget & { destPath: string } }>
  | Readonly<{ success: false; error: string }> {
  const parsed = DeploymentBackupRestoreUploadInitV1Schema.safeParse(input.request);
  if (!parsed.success || !input.accountId) return { success: false, error: 'Invalid restore upload scope' };
  const { environmentId, sizeBytes } = parsed.data;
  if (isServerRoutedTransferOverSizeLimit(sizeBytes, input.sessionRpcTransferMaxBytes ?? null)) {
    return { success: false, error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR };
  }
  if (sizeBytes > configuration.filesUploadMaxFileBytes) return { success: false, error: 'File exceeds upload size limit' };
  const scopeFingerprint = deploymentRestoreUploadScope(input.accountId, environmentId);
  return { success: true, target: {
    destPath: '', destDisplayPath: '', expectedSizeBytes: sizeBytes, overwrite: false,
    finalizeUpload: async ({ uploadId, tempPath, sizeBytes, sha256 }) => {
      input.store.retainCompletedUpload({ uploadId, filePath: tempPath, sizeBytes, sha256, scopeFingerprint });
      return { success: true, path: '', sizeBytes };
    },
  } };
}

export function acquireDeploymentRestoreUpload(store: TransferSessionStore,
  input: Readonly<{ transferId: string; environmentId: string; accountId: string }>):
  Readonly<{ source: AdmittedDeploymentRestoreUpload; release(): void }> | null {
  const admitted = store.beginCompletedUploadOperation(input.transferId, deploymentRestoreUploadScope(input.accountId, input.environmentId));
  if (!admitted) return null;
  const artifact = admitted.artifact;
  const source = createFileTransferPayloadSource({ filePath: artifact.filePath, sizeBytes: artifact.sizeBytes,
    manifestHash: `sha256:${artifact.sha256}` });
  return { source: { kind: 'upload', transferId: artifact.uploadId, filePath: artifact.filePath,
    sizeBytes: artifact.sizeBytes, sha256: artifact.sha256,
    readChunk: admitted.readChunk ?? (input => readTransferPayloadChunk({ source, ...input })) }, release: admitted.release };
}
