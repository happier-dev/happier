import { lstat, mkdir, realpath } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';

export type WorkspaceSyncTargetBootstrapInput = Readonly<{ rootPath: string; createIfMissing?: boolean }>;
export type WorkspaceSyncTargetBootstrapResult = Readonly<{ canonicalRoot: string; created: boolean }>;

export async function workspaceSyncTargetBootstrap(input: WorkspaceSyncTargetBootstrapInput): Promise<WorkspaceSyncTargetBootstrapResult> {
  const requested = normalize(resolve(input.rootPath.trim()));
  if (!requested || requested === resolve('/')) throw Object.assign(new Error('workspace sync target root is invalid'), { code: 'root_invalid' });
  let created = false;
  try {
    const stats = await lstat(requested);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw Object.assign(new Error('workspace sync target root must be a real directory'), { code: 'root_invalid' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !input.createIfMissing) throw error;
    await mkdir(requested, { recursive: true });
    created = true;
  }
  const canonicalRoot = await realpath(requested);
  return { canonicalRoot, created };
}

export const prepareWorkspaceSyncTargetBootstrap = workspaceSyncTargetBootstrap;
