import { randomUUID } from 'crypto';
import { chmod, mkdir, open, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { isPidPresent } from '@happier-dev/cli-common/process';
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
  activeOperationCount: number;
};

type DownloadSession = {
  downloadId: string;
  filePath: string;
  deleteFileOnClose: boolean;
  sourceOffsetBytes: number;
  sizeBytes: number;
  offset: number;
  nextIndex: number;
  chunkSizeBytes: number;
  expiresAt: number;
  recipientPublicKeyBase64?: string;
  file: Awaited<ReturnType<typeof open>>;
  activeOperationCount: number;
};

export type TransferSessionStoreDeps = Readonly<{
  ttlMs: number;
  tempRoot?: string | null;
  /**
   * Who triggers expiry for this store.
   *
   * `owner` (default) means the constructing owner already schedules the sweep
   * and stays the single trigger — the direct-peer import manager does, coupling
   * it to idle shutdown and to its own membership mirror. `self` arms the
   * store's own deadline for a store nothing else sweeps, whose sessions would
   * otherwise hold their descriptor and temp file until the process exits.
   */
  expiryTrigger?: 'owner' | 'self';
}>;

export class TransferSessionStore {
  private readonly uploads = new Map<string, UploadSession>();
  private readonly downloads = new Map<string, DownloadSession>();
  private readonly baseTempRoot: string;
  private readonly tempRoot: string;
  private readonly ttlMs: number;
  private readonly ownsExpiryTrigger: boolean;
  private readonly pendingClosures = new Set<Promise<void>>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimerAt: number | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private abandonedRootSweepPromise: Promise<void> | null = null;

  constructor(deps: TransferSessionStoreDeps) {
    this.ttlMs = Math.max(1000, Math.floor(deps.ttlMs));
    this.ownsExpiryTrigger = deps.expiryTrigger === 'self';
    const overrideTempRoot = typeof deps.tempRoot === 'string' && deps.tempRoot.trim().length > 0
      ? deps.tempRoot.trim()
      : null;
    const baseTempRoot = overrideTempRoot ?? join(tmpdir(), 'happier', 'file-transfers');
    this.baseTempRoot = baseTempRoot;
    this.tempRoot = join(baseTempRoot, `${process.pid}-${randomUUID()}`);
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error('Transfer session store is disposed');
    }
  }

  async ensureTempRoot(): Promise<void> {
    this.assertOpen();
    this.abandonedRootSweepPromise ??= this.removeDeadProcessRootsBestEffort();
    await this.abandonedRootSweepPromise;
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      // Best effort: keep transfer temp dirs private. Parent traversal also matters, but this is a useful default.
      await chmod(this.tempRoot, 0o700).catch(() => undefined);
    }
  }

  private async removeDeadProcessRootsBestEffort(): Promise<void> {
    const entries = await readdir(this.baseTempRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const match = /^(?<pid>[1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(entry.name);
      const ownerPid = Number(match?.groups?.pid ?? Number.NaN);
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || isPidPresent(ownerPid)) {
        // Unowned legacy roots and roots belonging to a possibly-live process are preserved.
        return;
      }
      await rm(join(this.baseTempRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }));
  }

  private beginSessionOperation<TSession extends { activeOperationCount: number }>(
    session: TSession | undefined,
  ): Readonly<{ session: TSession; release(): void }> | null {
    if (!session) return null;
    session.activeOperationCount += 1;
    let released = false;
    return {
      session,
      release: () => {
        if (released) return;
        released = true;
        session.activeOperationCount -= 1;
        // An idle session is eligible for the autonomous sweep again; the sweep
        // deliberately ignores sessions with work in flight, so its deadline is
        // only knowable once the last operation releases.
        this.scheduleExpirySweep();
      },
    };
  }

  /**
   * Sweep expired sessions and resolve once every descriptor they held is
   * closed and every temp file they owned is gone.
   *
   * Callers that delete the underlying files next must await this: releasing
   * the map entry without awaiting `close()` leaves a live handle on the file,
   * and on Windows a concurrent delete of that path fails while it is open.
   */
  async cleanupExpired(now = Date.now()): Promise<void> {
    await Promise.all(this.collectExpiredClosures(now));
  }

  cleanupExpiredBestEffort(now = Date.now()): void {
    // Same sweep, not awaited: hot RPC paths only need the sessions retired.
    // `settleClosures()` and `dispose()` still join the closures it started.
    for (const closure of this.collectExpiredClosures(now)) {
      closure.catch(() => undefined);
    }
  }

  /** Resolves once every closure started by a best-effort sweep has finished. */
  async settleClosures(): Promise<void> {
    while (this.pendingClosures.size > 0) {
      await Promise.all([...this.pendingClosures]);
    }
  }

  private collectExpiredClosures(now: number): readonly Promise<void>[] {
    if (this.disposed) return [];
    const closures: Promise<void>[] = [];

    for (const [uploadId, session] of this.uploads) {
      if (session.expiresAt > now || session.activeOperationCount > 0) continue;
      this.uploads.delete(uploadId);
      closures.push(this.trackClosure(async () => {
        await session.file.close().catch(() => undefined);
        await rm(session.tempPath, { force: true }).catch(() => undefined);
      }));
    }

    for (const [downloadId, session] of this.downloads) {
      if (session.expiresAt > now || session.activeOperationCount > 0) continue;
      this.downloads.delete(downloadId);
      closures.push(this.trackClosure(async () => {
        await session.file.close().catch(() => undefined);
        if (session.deleteFileOnClose) {
          await rm(session.filePath, { force: true }).catch(() => undefined);
        }
      }));
    }

    this.scheduleExpirySweep();
    return closures;
  }

  private trackClosure(operation: () => Promise<void>): Promise<void> {
    const closure = operation().finally(() => {
      this.pendingClosures.delete(closure);
    });
    this.pendingClosures.add(closure);
    return closure;
  }

  /**
   * Arm the store's own expiry sweep.
   *
   * Without it an abandoned session (the client process died between `init` and
   * the first chunk) holds its descriptor and temp file until some unrelated
   * request happens to sweep, which for a store whose only traffic is that one
   * transfer means until the daemon exits.
   */
  private scheduleExpirySweep(): void {
    if (!this.ownsExpiryTrigger) return;
    const nextExpiryAt = this.getNextExpiryAt();
    if (nextExpiryAt === null) {
      this.clearExpiryTimer();
      return;
    }
    if (this.expiryTimer && this.expiryTimerAt !== null && this.expiryTimerAt <= nextExpiryAt) return;
    this.clearExpiryTimer();
    this.expiryTimerAt = nextExpiryAt;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expiryTimerAt = null;
      this.cleanupExpiredBestEffort();
    }, Math.min(2_147_483_647, Math.max(0, nextExpiryAt - Date.now())));
    this.expiryTimer.unref?.();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.expiryTimerAt = null;
  }

  getNextExpiryAt(): number | null {
    if (this.disposed) return null;

    let nextExpiryAt: number | null = null;
    for (const session of this.uploads.values()) {
      if (session.activeOperationCount > 0) continue;
      nextExpiryAt = nextExpiryAt === null
        ? session.expiresAt
        : Math.min(nextExpiryAt, session.expiresAt);
    }
    for (const session of this.downloads.values()) {
      if (session.activeOperationCount > 0) continue;
      nextExpiryAt = nextExpiryAt === null
        ? session.expiresAt
        : Math.min(nextExpiryAt, session.expiresAt);
    }
    return nextExpiryAt;
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
    this.assertOpen();
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
      activeOperationCount: 0,
    };
    this.uploads.set(uploadId, session);
    this.scheduleExpirySweep();
    return session;
  }

  getUploadSession(uploadId: string): UploadSession | null {
    return this.uploads.get(uploadId) ?? null;
  }

  beginUploadSessionOperation(
    uploadId: string,
  ): Readonly<{ session: UploadSession; release(): void }> | null {
    return this.beginSessionOperation(this.uploads.get(uploadId));
  }

  countUploadSessions(): number {
    return this.uploads.size;
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
    sourceOffsetBytes?: number;
    sizeBytes?: number;
  }>): Promise<DownloadSession> {
    this.assertOpen();
    const stats = await stat(input.filePath);
    const sourceOffsetBytes = Number.isSafeInteger(input.sourceOffsetBytes)
      && (input.sourceOffsetBytes ?? 0) >= 0
      ? input.sourceOffsetBytes ?? 0
      : 0;
    const sizeBytes = Number.isSafeInteger(input.sizeBytes)
      && (input.sizeBytes ?? 0) >= 0
      ? input.sizeBytes ?? 0
      : stats.size - sourceOffsetBytes;
    if (
      !Number.isSafeInteger(stats.size)
      || sourceOffsetBytes > stats.size
      || sizeBytes > stats.size - sourceOffsetBytes
    ) {
      throw new Error('Download source range exceeds file size');
    }
    const downloadId = randomUUID();
    const file = await open(input.filePath, 'r');
    const session: DownloadSession = {
      downloadId,
      filePath: input.filePath,
      deleteFileOnClose: input.deleteFileOnClose,
      sourceOffsetBytes,
      sizeBytes,
      offset: 0,
      nextIndex: 0,
      chunkSizeBytes: input.chunkSizeBytes,
      expiresAt: Date.now() + this.ttlMs,
      recipientPublicKeyBase64: input.recipientPublicKeyBase64,
      file,
      activeOperationCount: 0,
    };
    this.downloads.set(downloadId, session);
    this.scheduleExpirySweep();
    return session;
  }

  getDownloadSession(downloadId: string): DownloadSession | null {
    return this.downloads.get(downloadId) ?? null;
  }

  beginDownloadSessionOperation(
    downloadId: string,
  ): Readonly<{ session: DownloadSession; release(): void }> | null {
    return this.beginSessionOperation(this.downloads.get(downloadId));
  }

  listDownloadSessionIds(): readonly string[] {
    return [...this.downloads.keys()];
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

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }

    this.disposed = true;
    this.clearExpiryTimer();
    const uploads = [...this.uploads.values()];
    const downloads = [...this.downloads.values()];
    this.uploads.clear();
    this.downloads.clear();

    this.disposePromise = (async () => {
      await this.settleClosures();
      await Promise.all([
        ...uploads.map(async (session) => {
          await session.file.close().catch(() => undefined);
          await rm(session.tempPath, { force: true }).catch(() => undefined);
        }),
        ...downloads.map(async (session) => {
          await session.file.close().catch(() => undefined);
          if (session.deleteFileOnClose) {
            await rm(session.filePath, { force: true }).catch(() => undefined);
          }
        }),
      ]);
      await rm(this.tempRoot, { recursive: true, force: true }).catch(() => undefined);
    })();

    return await this.disposePromise;
  }
}
