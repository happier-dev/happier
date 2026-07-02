import { chmod, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ZELLIJ_IPC_SOCKET_PATH_MAX_BYTES = 103;
const ZELLIJ_GENERATED_SOCKET_SUFFIX_RESERVE_BYTES = 64;

export function resolveZellijSocketDir(happyHomeDir: string): string {
  const homeSocketDir = join(happyHomeDir, 'zellij-sock');
  const maxBaseDirBytes = ZELLIJ_IPC_SOCKET_PATH_MAX_BYTES - ZELLIJ_GENERATED_SOCKET_SUFFIX_RESERVE_BYTES;
  if (process.platform !== 'win32' && Buffer.byteLength(homeSocketDir) > maxBaseDirBytes) {
    const digest = createHash('sha256').update(happyHomeDir).digest('hex').slice(0, 16);
    return join('/tmp', `happier-zellij-${digest}`);
  }
  return homeSocketDir;
}

export async function prepareZellijSocketDir(socketDir: string): Promise<void> {
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  const info = await stat(socketDir);
  if (!info.isDirectory()) {
    throw new Error(`zellij socket directory is not a directory: ${socketDir}`);
  }

  if (process.platform === 'win32') return;

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && info.uid !== currentUid) {
    throw new Error(`zellij socket directory is not owned by the current user: ${socketDir}`);
  }

  if ((info.mode & 0o077) !== 0) {
    await chmod(socketDir, 0o700);
    const updated = await stat(socketDir);
    if ((updated.mode & 0o077) !== 0) {
      throw new Error(`zellij socket directory permissions are not owner-only: ${socketDir}`);
    }
  }
}
