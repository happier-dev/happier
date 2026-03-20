import { randomUUID } from 'crypto';
import { mkdir, open, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import type { UploadTransferTarget } from '../targets/uploadTransferTarget';

type UploadSession = {
  uploadId: string;
  tempPath: string;
  destPath: string;
  destDisplayPath: string;
  overwrite: boolean;
  expectedSizeBytes: number;
  finalizeUpload: UploadTransferTarget<unknown>['finalizeUpload'];
  receivedBytes: number;
  nextIndex: number;
  chunkSizeBytes: number;
  expiresAt: number;
  sha256Expected?: string;
  recipientSecretKeySeed?: Uint8Array;
  recipientPublicKeyBase64?: string;
  hash: ReturnType<typeof import('crypto').createHash>;
  file: Awaited<ReturnType<typeof open>>;
};

type DownloadSession = {
  downloadId: string;
  filePath: string;
  deleteFileOnClose: boolean;
  sizeBytes: number;
  offset: number;
  nextIndex: number;
  chunkSizeBytes: number;
  expiresAt: number;
  recipientPublicKeyBase64?: string;
  file: Awaited<ReturnType<typeof open>>;
};

export type TransferSessionStoreDeps = Readonly<{
  ttlMs: number;
}>;

export class TransferSessionStore {
  private readonly uploads = new Map<string, UploadSession>();
  private readonly downloads = new Map<string, DownloadSession>();
  private readonly tempRoot: string;
  private readonly ttlMs: number;

  constructor(deps: TransferSessionStoreDeps) {
    this.ttlMs = Math.max(1000, Math.floor(deps.ttlMs));
    this.tempRoot = join(tmpdir(), 'happier', 'file-transfers', randomUUID());
  }

  async ensureTempRoot(): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true });
  }

  cleanupExpiredBestEffort(now = Date.now()): void {
    for (const [uploadId, session] of this.uploads) {
      if (session.expiresAt > now) continue;
      this.uploads.delete(uploadId);
      session.file.close().catch(() => undefined);
      rm(session.tempPath, { force: true }).catch(() => undefined);
    }

    for (const [downloadId, session] of this.downloads) {
      if (session.expiresAt > now) continue;
      this.downloads.delete(downloadId);
      session.file.close().catch(() => undefined);
      if (session.deleteFileOnClose) {
        rm(session.filePath, { force: true }).catch(() => undefined);
      }
    }
  }

  async createUploadSession(input: Readonly<{
    destPath: string;
    destDisplayPath: string;
    overwrite: boolean;
    expectedSizeBytes: number;
    finalizeUpload: UploadTransferTarget<unknown>['finalizeUpload'];
    chunkSizeBytes: number;
    sha256Expected?: string;
    recipientSecretKeySeed?: Uint8Array;
    recipientPublicKeyBase64?: string;
    hash: UploadSession['hash'];
  }>): Promise<UploadSession> {
    await this.ensureTempRoot();
    const uploadId = randomUUID();
    const tempPath = join(this.tempRoot, `${uploadId}.upload`);
    await mkdir(dirname(tempPath), { recursive: true });
    const file = await open(tempPath, 'w');
    const session: UploadSession = {
      uploadId,
      tempPath,
      destPath: input.destPath,
      destDisplayPath: input.destDisplayPath,
      overwrite: input.overwrite,
      expectedSizeBytes: input.expectedSizeBytes,
      finalizeUpload: input.finalizeUpload,
      receivedBytes: 0,
      nextIndex: 0,
      chunkSizeBytes: input.chunkSizeBytes,
      expiresAt: Date.now() + this.ttlMs,
      sha256Expected: input.sha256Expected,
      recipientSecretKeySeed: input.recipientSecretKeySeed,
      recipientPublicKeyBase64: input.recipientPublicKeyBase64,
      hash: input.hash,
      file,
    };
    this.uploads.set(uploadId, session);
    return session;
  }

  getUploadSession(uploadId: string): UploadSession | null {
    return this.uploads.get(uploadId) ?? null;
  }

  refreshUploadExpiry(uploadId: string): void {
    const session = this.uploads.get(uploadId);
    if (session) {
      session.expiresAt = Date.now() + this.ttlMs;
    }
  }

  private async closeUploadSession(
    uploadId: string,
    opts?: Readonly<{ deleteTempFile?: boolean }>,
  ): Promise<UploadSession | null> {
    const session = this.uploads.get(uploadId);
    if (!session) return null;
    this.uploads.delete(uploadId);
    await session.file.close().catch(() => undefined);
    if (opts?.deleteTempFile === true) {
      await rm(session.tempPath, { force: true }).catch(() => undefined);
    }
    return session;
  }

  async abortUploadSession(uploadId: string): Promise<void> {
    await this.closeUploadSession(uploadId, { deleteTempFile: true });
  }

  async finalizeUploadSession(uploadId: string): Promise<UploadSession | null> {
    return await this.closeUploadSession(uploadId);
  }

  async createDownloadSession(input: Readonly<{
    filePath: string;
    deleteFileOnClose: boolean;
    chunkSizeBytes: number;
    recipientPublicKeyBase64?: string;
  }>): Promise<DownloadSession> {
    const stats = await stat(input.filePath);
    const downloadId = randomUUID();
    const file = await open(input.filePath, 'r');
    const session: DownloadSession = {
      downloadId,
      filePath: input.filePath,
      deleteFileOnClose: input.deleteFileOnClose,
      sizeBytes: stats.size,
      offset: 0,
      nextIndex: 0,
      chunkSizeBytes: input.chunkSizeBytes,
      expiresAt: Date.now() + this.ttlMs,
      recipientPublicKeyBase64: input.recipientPublicKeyBase64,
      file,
    };
    this.downloads.set(downloadId, session);
    return session;
  }

  getDownloadSession(downloadId: string): DownloadSession | null {
    return this.downloads.get(downloadId) ?? null;
  }

  refreshDownloadExpiry(downloadId: string): void {
    const session = this.downloads.get(downloadId);
    if (session) {
      session.expiresAt = Date.now() + this.ttlMs;
    }
  }

  async closeDownloadSession(downloadId: string): Promise<void> {
    const session = this.downloads.get(downloadId);
    if (!session) return;
    this.downloads.delete(downloadId);
    await session.file.close().catch(() => undefined);
    if (session.deleteFileOnClose) {
      await rm(session.filePath, { force: true }).catch(() => undefined);
    }
  }
}
