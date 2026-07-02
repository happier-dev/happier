import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG,
  normalizeSessionMediaWorkspaceRelativeDir,
  type SessionMediaTransferConfig,
} from '@/transfers/targets/resolveSessionMediaTransferTarget';

import {
  type GarbageCollectSessionMediaResult,
} from './budget';
import { normalizeWorkspaceRelativeMediaPath } from './paths';

type LoggerLike = Readonly<{
  debug: (message: string, details?: unknown) => void;
}>;

const SESSION_MEDIA_CATEGORIES = ['messages', 'generated', 'artifacts'] as const;
const CLEANUP_FAILURE_MESSAGE = '[session-media] Failed to garbage-collect uncommitted session media (non-fatal)';

function logCleanupFailure(
  logger: LoggerLike | undefined,
  details: Readonly<{ reason: 'failed_durable_write' | 'interrupted_ingestion'; error: unknown }>,
): void {
  try {
    logger?.debug(CLEANUP_FAILURE_MESSAGE, details);
  } catch {
    // Cleanup logging is best-effort and must not mask the caller's original error.
  }
}

function isCandidateSessionMediaPath(input: Readonly<{
  workspaceRelativePath: string;
  workspaceRelativeDir: string;
}>): boolean {
  const root = normalizeWorkspaceRelativeMediaPath(input.workspaceRelativeDir);
  if (!root) return false;
  const prefix = `${root}/`;
  if (!input.workspaceRelativePath.startsWith(prefix)) return false;
  const [category] = input.workspaceRelativePath.slice(prefix.length).split('/');
  return SESSION_MEDIA_CATEGORIES.includes(category as (typeof SESSION_MEDIA_CATEGORIES)[number]);
}

async function deleteCandidateFile(input: Readonly<{
  workingDirectory: string;
  workspaceRelativePath: string;
}>): Promise<GarbageCollectSessionMediaResult> {
  const absolutePath = join(input.workingDirectory, input.workspaceRelativePath);
  const entryStat = await lstat(absolutePath).catch((error: unknown) => {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (!entryStat || !entryStat.isFile()) {
    return { deletedFiles: 0, deletedBytes: 0 };
  }

  await unlink(absolutePath).catch((error: unknown) => {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
      return;
    }
    throw error;
  });
  return { deletedFiles: 1, deletedBytes: entryStat.size };
}

export async function garbageCollectUncommittedSessionMedia(params: Readonly<{
  workingDirectory: string;
  candidateWorkspaceRelativePaths: readonly string[];
  config?: SessionMediaTransferConfig;
  reason: 'failed_durable_write' | 'interrupted_ingestion';
  logger?: LoggerLike;
}>): Promise<GarbageCollectSessionMediaResult | null> {
  const config = params.config ?? DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG;
  const workspaceRelativeDir = normalizeSessionMediaWorkspaceRelativeDir(config.workspaceRelativeDir);
  if (!workspaceRelativeDir || config.uploadLocation !== 'workspace') {
    return { deletedFiles: 0, deletedBytes: 0 };
  }

  const candidates = new Set<string>();
  for (const value of params.candidateWorkspaceRelativePaths) {
    const normalized = normalizeWorkspaceRelativeMediaPath(value);
    if (
      normalized
      && isCandidateSessionMediaPath({
        workspaceRelativePath: normalized,
        workspaceRelativeDir,
      })
    ) {
      candidates.add(normalized);
    }
  }
  if (candidates.size === 0) {
    return { deletedFiles: 0, deletedBytes: 0 };
  }

  try {
    let deletedFiles = 0;
    let deletedBytes = 0;
    for (const workspaceRelativePath of candidates) {
      const result = await deleteCandidateFile({
        workingDirectory: params.workingDirectory,
        workspaceRelativePath,
      });
      deletedFiles += result.deletedFiles;
      deletedBytes += result.deletedBytes;
    }
    return { deletedFiles, deletedBytes };
  } catch (error) {
    logCleanupFailure(params.logger, {
      reason: params.reason,
      error,
    });
    return null;
  }
}
