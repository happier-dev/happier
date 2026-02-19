import { createHash, randomUUID } from 'crypto';
import { mkdir, open, rename, rm, readFile as fsReadFile, writeFile as fsWriteFile, stat as fsStat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { validatePath } from './pathSecurity';

type UploadLocation = 'workspace' | 'os_temp';
type VcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

type ConfigureRequest = Readonly<{
  uploadLocation?: UploadLocation;
  workspaceRelativeDir?: string;
  vcsIgnoreStrategy?: VcsIgnoreStrategy;
  vcsIgnoreWritesEnabled?: boolean;
  maxFileBytes?: number;
  uploadTtlMs?: number;
  chunkSizeBytes?: number;
}>;

type ConfigureResponse = Readonly<{ success: true } | { success: false; error: string }>;

type UploadInitRequest = Readonly<{
  name: string;
  sizeBytes: number;
  mimeType?: string;
  sha256?: string;
  messageLocalId?: string;
}>;

type UploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number }>
  | Readonly<{ success: false; error: string }>;

type UploadChunkRequest = Readonly<{
  uploadId: string;
  index: number;
  contentBase64: string;
}>;

type UploadChunkResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string }>;

type UploadFinalizeRequest = Readonly<{ uploadId: string }>;

type UploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
  | Readonly<{ success: false; error: string }>;

type UploadAbortRequest = Readonly<{ uploadId: string }>;

type UploadAbortResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string }>;

type AttachmentsConfig = Readonly<{
  uploadLocation: UploadLocation;
  workspaceRelativeDir: string;
  vcsIgnoreStrategy: VcsIgnoreStrategy;
  vcsIgnoreWritesEnabled: boolean;
  maxFileBytes: number;
  uploadTtlMs: number;
  chunkSizeBytes: number;
}>;

const DEFAULT_CONFIG: AttachmentsConfig = {
  uploadLocation: 'workspace',
  workspaceRelativeDir: '.happier/uploads',
  vcsIgnoreStrategy: 'git_info_exclude',
  vcsIgnoreWritesEnabled: true,
  maxFileBytes: 25 * 1024 * 1024,
  uploadTtlMs: 5 * 60 * 1000,
  chunkSizeBytes: 256 * 1024,
};

function normalizeUploadLocation(value: unknown): UploadLocation | null {
  if (value === 'workspace' || value === 'os_temp') return value;
  return null;
}

function normalizeVcsIgnoreStrategy(value: unknown): VcsIgnoreStrategy | null {
  if (value === 'git_info_exclude' || value === 'gitignore' || value === 'none') return value;
  return null;
}

function normalizeWorkspaceRelativeDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  const parts = trimmed.split(/[\\/]+/g).filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return parts.join('/');
}

function sanitizeFileName(value: string): string {
  const raw = String(value ?? '');
  const base = raw.split(/[/\\]/g).pop() ?? '';
  const trimmed = base.trim() || 'file';
  const safe = trimmed.replace(/[^\w.\- ()]/g, '_');
  const collapsed = safe.replace(/_+/g, '_');
  const finalName = collapsed === '.' || collapsed === '..' ? 'file' : collapsed;
  return finalName.length > 200 ? finalName.slice(-200) : finalName;
}

function normalizePositiveInt(value: unknown, fallback: number, opts?: Readonly<{ min?: number; max?: number }>): number {
  const raw = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(raw) ? Math.floor(raw) : fallback;
  const min = typeof opts?.min === 'number' ? opts.min : 1;
  const max = typeof opts?.max === 'number' ? opts.max : Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, normalized));
}

async function resolveGitDirBestEffort(workingDirectory: string): Promise<string | null> {
  const dotGitPath = join(workingDirectory, '.git');
  let gitDir: string | null = null;
  try {
    const dotGitStat = await fsStat(dotGitPath);
    if (dotGitStat.isDirectory()) {
      gitDir = dotGitPath;
    } else if (dotGitStat.isFile()) {
      const contents = await fsReadFile(dotGitPath, 'utf8');
      const match = contents.match(/^\s*gitdir:\s*(.+)\s*$/mi);
      const raw = match?.[1]?.trim();
      if (raw) {
        // gitdir may be relative to the working directory.
        gitDir = join(workingDirectory, raw);
      }
    }
  } catch {
    // Not a git repo (or inaccessible): do not create .git or write excludes.
    return null;
  }

  if (!gitDir) return null;
  try {
    const gitDirStat = await fsStat(gitDir);
    if (!gitDirStat.isDirectory()) return null;
  } catch {
    return null;
  }
  return gitDir;
}

async function ensureGitInfoExcludeContainsRule(workingDirectory: string, workspaceRelativeDir: string): Promise<void> {
  const gitDir = await resolveGitDirBestEffort(workingDirectory);
  if (!gitDir) return;

  const gitInfoExcludePath = join(gitDir, 'info', 'exclude');
  const rule = `/${workspaceRelativeDir.replace(/^[\\/]+/, '').replace(/[\\]+/g, '/')}/`;
  const ruleLine = rule.endsWith('/') ? rule : `${rule}/`;

  let current = '';
  try {
    current = await fsReadFile(gitInfoExcludePath, 'utf8');
  } catch {
    // Ensure parent exists and create the file (inside an existing gitDir only).
    await mkdir(dirname(gitInfoExcludePath), { recursive: true });
  }

  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes(ruleLine)) return;

  const next = current && !current.endsWith('\n') ? `${current}\n${ruleLine}\n` : `${current}${ruleLine}\n`;
  await mkdir(dirname(gitInfoExcludePath), { recursive: true });
  await fsWriteFile(gitInfoExcludePath, next, 'utf8');
}

async function ensureGitignoreContainsRule(workingDirectory: string, workspaceRelativeDir: string): Promise<void> {
  const gitDir = await resolveGitDirBestEffort(workingDirectory);
  if (!gitDir) return;

  const gitignorePath = join(workingDirectory, '.gitignore');
  const rule = `/${workspaceRelativeDir.replace(/^[\\/]+/, '').replace(/[\\]+/g, '/')}/`;
  const ruleLine = rule.endsWith('/') ? rule : `${rule}/`;

  let current = '';
  try {
    current = await fsReadFile(gitignorePath, 'utf8');
  } catch {
    // Create .gitignore at the working directory root (best-effort).
  }

  const lines = current.split('\n').map((l) => l.trim());
  if (lines.includes(ruleLine)) return;

  const next = current && !current.endsWith('\n') ? `${current}\n${ruleLine}\n` : `${current}${ruleLine}\n`;
  await fsWriteFile(gitignorePath, next, 'utf8');
}

type UploadSession = {
  uploadId: string;
  tempPath: string;
  finalPath: string;
  expectedSizeBytes: number;
  receivedBytes: number;
  nextIndex: number;
  hash: ReturnType<typeof createHash>;
  expiresAt: number;
  file: Awaited<ReturnType<typeof open>>;
};

export function registerAttachmentsUploadHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    setAdditionalAllowedReadDirs: (dirs: string[]) => void;
  }>,
): void {
  const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());

  let config: AttachmentsConfig = DEFAULT_CONFIG;
  const uploads = new Map<string, UploadSession>();

  const applyConfigSideEffectsBestEffort = async (): Promise<void> => {
    if (config.uploadLocation === 'os_temp') {
      deps.setAdditionalAllowedReadDirs([tempUploadRoot]);
      return;
    }
    deps.setAdditionalAllowedReadDirs([]);
  };

  const cleanupExpiredBestEffort = async (): Promise<void> => {
    const now = Date.now();
    const expired: UploadSession[] = [];
    for (const session of uploads.values()) {
      if (session.expiresAt <= now) expired.push(session);
    }
    await Promise.all(
      expired.map(async (session) => {
        uploads.delete(session.uploadId);
        await session.file.close().catch(() => {});
        await rm(session.tempPath, { force: true }).catch(() => {});
      }),
    );
  };

  rpcHandlerManager.registerHandler<ConfigureRequest, ConfigureResponse>('attachments.configure', async (data) => {
    await cleanupExpiredBestEffort();

    const nextLocation = normalizeUploadLocation(data?.uploadLocation) ?? config.uploadLocation;
    const nextDir = normalizeWorkspaceRelativeDir(data?.workspaceRelativeDir) ?? config.workspaceRelativeDir;
    const nextStrategy = normalizeVcsIgnoreStrategy(data?.vcsIgnoreStrategy) ?? config.vcsIgnoreStrategy;
    const nextWritesEnabled = typeof data?.vcsIgnoreWritesEnabled === 'boolean' ? data.vcsIgnoreWritesEnabled : config.vcsIgnoreWritesEnabled;
    const nextMaxFileBytes = normalizePositiveInt(data?.maxFileBytes, config.maxFileBytes, { min: 1024, max: 1024 * 1024 * 1024 });
    const nextTtlMs = normalizePositiveInt(data?.uploadTtlMs, config.uploadTtlMs, { min: 5000, max: 60 * 60 * 1000 });
    const nextChunkSize = normalizePositiveInt(data?.chunkSizeBytes, config.chunkSizeBytes, { min: 4096, max: 1024 * 1024 });

    config = {
      uploadLocation: nextLocation,
      workspaceRelativeDir: nextDir,
      vcsIgnoreStrategy: nextStrategy,
      vcsIgnoreWritesEnabled: nextWritesEnabled,
      maxFileBytes: nextMaxFileBytes,
      uploadTtlMs: nextTtlMs,
      chunkSizeBytes: nextChunkSize,
    };

    try {
      await applyConfigSideEffectsBestEffort();
    } catch {
      // fail closed: if we can't apply side-effects, keep feature usable but don't expand read roots.
      deps.setAdditionalAllowedReadDirs([]);
    }

    // Best-effort local-only VCS ignore configuration for workspace uploads.
    if (config.uploadLocation === 'workspace' && config.vcsIgnoreWritesEnabled && config.vcsIgnoreStrategy === 'git_info_exclude') {
      try {
        await ensureGitInfoExcludeContainsRule(deps.workingDirectory, config.workspaceRelativeDir);
      } catch {
        // Best-effort only.
      }
    }
    if (config.uploadLocation === 'workspace' && config.vcsIgnoreWritesEnabled && config.vcsIgnoreStrategy === 'gitignore') {
      try {
        await ensureGitignoreContainsRule(deps.workingDirectory, config.workspaceRelativeDir);
      } catch {
        // Best-effort only.
      }
    }

    return { success: true };
  });

  rpcHandlerManager.registerHandler<UploadInitRequest, UploadInitResponse>('attachments.upload.init', async (data) => {
    await cleanupExpiredBestEffort();

    const name = sanitizeFileName(String(data?.name ?? 'file'));
    const sizeBytes = normalizePositiveInt(data?.sizeBytes, -1, { min: 0, max: config.maxFileBytes });
    if (sizeBytes < 0) {
      return { success: false, error: 'Invalid sizeBytes' };
    }
    if (sizeBytes > config.maxFileBytes) {
      return { success: false, error: 'File exceeds maximum allowed size' };
    }

    const uploadId = randomUUID();
    const messageId = typeof data?.messageLocalId === 'string' && data.messageLocalId.trim().length > 0 ? data.messageLocalId.trim() : randomUUID();
    const uniquePrefix = randomUUID().slice(0, 8);
    const fileName = `${uniquePrefix}-${name}`;

    const logicalPath = join(config.workspaceRelativeDir, 'messages', messageId, fileName);
    const finalPath = config.uploadLocation === 'workspace' ? logicalPath : join(tempUploadRoot, messageId, fileName);

    const validation = config.uploadLocation === 'workspace'
      ? validatePath(logicalPath, deps.workingDirectory)
      : validatePath(finalPath, deps.workingDirectory, [tempUploadRoot]);
    if (!validation.valid || !validation.resolvedPath) {
      return { success: false, error: validation.error ?? 'Invalid upload path' };
    }

    const resolvedFinal = validation.resolvedPath;
    const tempPath = `${resolvedFinal}.partial`;
    try {
      await mkdir(dirname(resolvedFinal), { recursive: true });
      await mkdir(dirname(tempPath), { recursive: true });
      const file = await open(tempPath, 'w');
      const session: UploadSession = {
        uploadId,
        tempPath,
        finalPath: resolvedFinal,
        expectedSizeBytes: sizeBytes,
        receivedBytes: 0,
        nextIndex: 0,
        hash: createHash('sha256'),
        expiresAt: Date.now() + config.uploadTtlMs,
        file,
      };
      uploads.set(uploadId, session);
      return { success: true, uploadId, chunkSizeBytes: config.chunkSizeBytes };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to initialize upload' };
    }
  });

  rpcHandlerManager.registerHandler<UploadChunkRequest, UploadChunkResponse>('attachments.upload.chunk', async (data) => {
    await cleanupExpiredBestEffort();

    const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : '';
    const session = uploads.get(uploadId);
    if (!session) {
      return { success: false, error: 'Unknown uploadId' };
    }

    if (typeof data?.index !== 'number' || !Number.isFinite(data.index) || Math.floor(data.index) !== data.index) {
      return { success: false, error: 'Invalid chunk index' };
    }
    if (data.index !== session.nextIndex) {
      return { success: false, error: 'Unexpected chunk index' };
    }

    const base64 = typeof data?.contentBase64 === 'string' ? data.contentBase64 : '';
    if (!base64) {
      return { success: false, error: 'Missing contentBase64' };
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return { success: false, error: 'Invalid base64 content' };
    }

    if (buffer.byteLength === 0 && session.expectedSizeBytes > 0) {
      return { success: false, error: 'Empty chunk' };
    }

    if (buffer.byteLength > config.chunkSizeBytes) {
      return { success: false, error: 'Chunk exceeds maximum size' };
    }

    const nextReceived = session.receivedBytes + buffer.byteLength;
    if (nextReceived > session.expectedSizeBytes) {
      return { success: false, error: 'Upload exceeds declared sizeBytes' };
    }

    try {
      await session.file.write(buffer, 0, buffer.byteLength, session.receivedBytes);
      session.hash.update(buffer);
      session.receivedBytes = nextReceived;
      session.nextIndex += 1;
      session.expiresAt = Date.now() + config.uploadTtlMs;
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write chunk' };
    }
  });

  rpcHandlerManager.registerHandler<UploadFinalizeRequest, UploadFinalizeResponse>('attachments.upload.finalize', async (data) => {
    await cleanupExpiredBestEffort();

    const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : '';
    const session = uploads.get(uploadId);
    if (!session) {
      return { success: false, error: 'Unknown uploadId' };
    }

    if (session.receivedBytes !== session.expectedSizeBytes) {
      return { success: false, error: 'Upload incomplete' };
    }

    uploads.delete(uploadId);
    try {
      await session.file.close();
      await rename(session.tempPath, session.finalPath);
      const digest = session.hash.digest('hex');

      return {
        success: true,
        path: config.uploadLocation === 'workspace' ? relative(deps.workingDirectory, session.finalPath) : session.finalPath,
        sizeBytes: session.expectedSizeBytes,
        sha256: digest,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to finalize upload' };
    }
  });

  rpcHandlerManager.registerHandler<UploadAbortRequest, UploadAbortResponse>('attachments.upload.abort', async (data) => {
    await cleanupExpiredBestEffort();

    const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : '';
    const session = uploads.get(uploadId);
    if (!session) {
      return { success: false, error: 'Unknown uploadId' };
    }
    uploads.delete(uploadId);
    await session.file.close().catch(() => {});
    await rm(session.tempPath, { force: true }).catch(() => {});
    return { success: true };
  });
}
