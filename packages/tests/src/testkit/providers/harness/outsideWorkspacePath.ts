import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function makeOutsideWorkspacePath(params: {
  workspaceDir: string;
  prefix: string;
  extension?: string;
  /**
   * Some providers treat the workspace as a project rooted above `workspaceDir` (e.g. git root),
   * so writing to `join(workspaceDir, '..', ...)` may still be considered "in workspace".
   *
   * Use `tmpdir` to force an unequivocally external path for those providers.
   */
  strategy?: 'workspace_parent' | 'tmpdir';
}): string {
  const extension = params.extension ?? '.txt';
  const filename = `${params.prefix}-${randomUUID()}${extension}`;
  if (params.strategy === 'tmpdir') {
    return join(tmpdir(), filename);
  }
  return join(params.workspaceDir, '..', filename);
}

export async function cleanupOutsideWorkspacePath(path: string | null | undefined): Promise<void> {
  if (!path) return;
  await unlink(path).catch(() => {});
}
