import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function makeOutsideWorkspacePath(params: {
  workspaceDir: string;
  prefix: string;
  extension?: string;
}): string {
  const extension = params.extension ?? '.txt';
  return join(params.workspaceDir, '..', `${params.prefix}-${randomUUID()}${extension}`);
}

export async function cleanupOutsideWorkspacePath(path: string | null | undefined): Promise<void> {
  if (!path) return;
  await unlink(path).catch(() => {});
}
