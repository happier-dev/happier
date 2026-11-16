import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { WorkspaceSource } from './workspaceSource';

export type WorkspaceTreeCopyLimits = Readonly<{
  /** Top-level directory names skipped at the copied root (e.g. `.git`, `node_modules`). */
  excludedTopLevelDirs?: readonly string[];
  maxEntryCount?: number;
  maxTotalBytes?: number;
}>;

export class WorkspaceTreeCopyLimitError extends Error {
  constructor(readonly limit: 'entries' | 'bytes') { super(limit === 'entries' ? 'Too many entries to copy' : 'Content exceeds the copy size limit'); }
}

/**
 * Copy one file, symbolic link or directory tree between workspace sources
 * (target→target for copy, target→this Machine's staging for folder download)
 * using only port operations. Links are copied as links, never followed.
 */
export async function copyWorkspaceTree(input: Readonly<{
  from: Readonly<{ source: WorkspaceSource; path: string }>;
  to: Readonly<{ source: WorkspaceSource; path: string }>;
  limits?: WorkspaceTreeCopyLimits;
  signal?: AbortSignal;
}>): Promise<void> {
  const { from, to, limits } = input;
  let entries = 0;
  let bytes = 0;
  const count = (size: number) => {
    entries += 1;
    bytes += size;
    if (limits?.maxEntryCount !== undefined && entries > limits.maxEntryCount) throw new WorkspaceTreeCopyLimitError('entries');
    if (limits?.maxTotalBytes !== undefined && bytes > limits.maxTotalBytes) throw new WorkspaceTreeCopyLimitError('bytes');
  };
  const copy = async (source: string, destination: string, depth: number): Promise<void> => {
    input.signal?.throwIfAborted();
    const stats = await from.source.lstat(source);
    if (stats.isSymbolicLink()) {
      count(0);
      await to.source.symlink(await from.source.readlink(source), destination);
      return;
    }
    if (stats.isDirectory()) {
      count(0);
      await to.source.mkdir(destination, { recursive: true });
      for (const entry of await from.source.readdir(source)) {
        if (depth === 0 && limits?.excludedTopLevelDirs?.includes(entry.name) && entry.isDirectory()) continue;
        await copy(join(source, entry.name), join(destination, entry.name), depth + 1);
      }
      return;
    }
    if (!stats.isFile()) return;
    count(stats.size);
    await to.source.mkdir(dirname(destination), { recursive: true });
    await to.source.writeFile(destination, await from.source.readFile(source));
  };
  await copy(from.path, to.path, 0);
}

export type WorkspaceTreeInstallOutcome = Readonly<{ status: 'installed' }> | Readonly<{ status: 'restored' }>;

/**
 * Install a copy at `to`: stage it beside the destination in the destination
 * source, then swap it in; a failed swap restores the previous destination.
 * Same outcome vocabulary as the local confined copy owner (installed / restored).
 */
export async function installWorkspaceTree(input: Readonly<{
  from: Readonly<{ source: WorkspaceSource; path: string }>;
  to: Readonly<{ source: WorkspaceSource; path: string }>;
  overwrite: boolean;
  signal?: AbortSignal;
  assertCurrentAuthority?: () => Promise<void>;
}>): Promise<WorkspaceTreeInstallOutcome> {
  const destination = input.to.source;
  const nonce = randomUUID();
  const staged = join(dirname(input.to.path), `.${basename(input.to.path)}.happier-copy-${nonce}`);
  const backup = join(dirname(input.to.path), `.${basename(input.to.path)}.happier-previous-${nonce}`);
  const exists = async (path: string) => await destination.lstat(path).then(() => true, (error: unknown) =>
    error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? false : Promise.reject(error));
  let backedUp = false;
  try {
    await copyWorkspaceTree({ from: input.from, to: { source: destination, path: staged }, signal: input.signal });
    await input.assertCurrentAuthority?.();
    if (await exists(input.to.path)) {
      if (!input.overwrite) throw Object.assign(new Error('Destination already exists'), { code: 'EEXIST' });
      await destination.rename(input.to.path, backup);
      backedUp = true;
    }
    await destination.rename(staged, input.to.path);
  } catch (error) {
    await destination.rm(staged, { recursive: true, force: true }).catch(() => undefined);
    if (backedUp) {
      await destination.rename(backup, input.to.path);
      return { status: 'restored' };
    }
    throw error;
  }
  if (backedUp) await destination.rm(backup, { recursive: true, force: true });
  return { status: 'installed' };
}
