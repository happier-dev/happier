import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG,
  normalizeSessionMediaWorkspaceRelativeDir,
  type SessionMediaTransferConfig,
} from '@/transfers/targets/resolveSessionMediaTransferTarget';

import { normalizeWorkspaceRelativeMediaPath } from './paths';

export type GarbageCollectSessionMediaResult = Readonly<{
  deletedFiles: number;
  deletedBytes: number;
}>;

export type SessionMediaBudgetFailure = Readonly<{
  code: string;
  error: string;
}>;

async function calculateDirectorySizeBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await calculateDirectorySizeBytes(entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const entryStat = await stat(entryPath).catch(() => null);
    total += entryStat?.size ?? 0;
  }
  return total;
}

async function garbageCollectSessionMediaDirectory(input: Readonly<{
  workingDirectory: string;
  directoryPath: string;
  keepPaths: ReadonlySet<string>;
}>): Promise<GarbageCollectSessionMediaResult> {
  const entries = await readdir(input.directoryPath, { withFileTypes: true }).catch(() => []);
  let deletedFiles = 0;
  let deletedBytes = 0;

  for (const entry of entries) {
    const entryPath = join(input.directoryPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const childResult = await garbageCollectSessionMediaDirectory({
        workingDirectory: input.workingDirectory,
        directoryPath: entryPath,
        keepPaths: input.keepPaths,
      });
      deletedFiles += childResult.deletedFiles;
      deletedBytes += childResult.deletedBytes;
      await rmdir(entryPath).catch(() => undefined);
      continue;
    }
    if (!entry.isFile()) continue;

    const workspaceRelativePath = normalizeWorkspaceRelativeMediaPath(relative(input.workingDirectory, entryPath));
    if (!workspaceRelativePath || input.keepPaths.has(workspaceRelativePath)) continue;
    const entryStat = await stat(entryPath).catch(() => null);
    await rm(entryPath, { force: true });
    deletedFiles += 1;
    deletedBytes += entryStat?.size ?? 0;
  }

  return { deletedFiles, deletedBytes };
}

export async function checkSessionMediaBudgets(input: Readonly<{
  workingDirectory: string;
  config: SessionMediaTransferConfig;
  sessionId: string;
  additionalBytes: number;
  sessionBudgetMaxBytes: number | null;
  workspaceBudgetMaxBytes: number | null;
}>): Promise<SessionMediaBudgetFailure | null> {
  const workspaceRelativeDir = normalizeSessionMediaWorkspaceRelativeDir(input.config.workspaceRelativeDir);
  if (!workspaceRelativeDir || input.config.uploadLocation !== 'workspace') return null;

  if (typeof input.sessionBudgetMaxBytes === 'number' && Number.isFinite(input.sessionBudgetMaxBytes)) {
    const sessionBudgetMaxBytes = Math.max(0, Math.trunc(input.sessionBudgetMaxBytes));
    const sessionBytes = await Promise.all(['messages', 'generated', 'artifacts'].map((category) =>
      calculateDirectorySizeBytes(join(input.workingDirectory, workspaceRelativeDir, category, input.sessionId)),
    ));
    const currentSessionBytes = sessionBytes.reduce((sum, value) => sum + value, 0);
    if (currentSessionBytes + input.additionalBytes > sessionBudgetMaxBytes) {
      return {
        code: 'session_media_session_budget_exceeded',
        error: 'Session media exceeds the configured per-session budget',
      };
    }
  }

  if (typeof input.workspaceBudgetMaxBytes === 'number' && Number.isFinite(input.workspaceBudgetMaxBytes)) {
    const workspaceBudgetMaxBytes = Math.max(0, Math.trunc(input.workspaceBudgetMaxBytes));
    const currentWorkspaceBytes = await calculateDirectorySizeBytes(join(input.workingDirectory, workspaceRelativeDir));
    if (currentWorkspaceBytes + input.additionalBytes > workspaceBudgetMaxBytes) {
      return {
        code: 'session_media_workspace_budget_exceeded',
        error: 'Session media exceeds the configured per-workspace budget',
      };
    }
  }

  return null;
}

export async function garbageCollectSessionMedia(params: Readonly<{
  workingDirectory: string;
  config?: SessionMediaTransferConfig;
  referencedWorkspaceRelativePaths: readonly string[];
  protectedWorkspaceRelativePaths?: readonly string[];
}>): Promise<GarbageCollectSessionMediaResult> {
  const config = params.config ?? DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG;
  const workspaceRelativeDir = normalizeSessionMediaWorkspaceRelativeDir(config.workspaceRelativeDir);
  if (!workspaceRelativeDir || config.uploadLocation !== 'workspace') {
    return { deletedFiles: 0, deletedBytes: 0 };
  }

  const keepPaths = new Set<string>();
  for (const path of [
    ...params.referencedWorkspaceRelativePaths,
    ...(params.protectedWorkspaceRelativePaths ?? []),
  ]) {
    const normalized = normalizeWorkspaceRelativeMediaPath(path);
    if (normalized) keepPaths.add(normalized);
  }

  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const category of ['messages', 'generated', 'artifacts']) {
    const categoryResult = await garbageCollectSessionMediaDirectory({
      workingDirectory: params.workingDirectory,
      directoryPath: join(params.workingDirectory, workspaceRelativeDir, category),
      keepPaths,
    });
    deletedFiles += categoryResult.deletedFiles;
    deletedBytes += categoryResult.deletedBytes;
  }

  return { deletedFiles, deletedBytes };
}
